"""Narrow loopback Crawl4AI adapter for the DeskPet local trial.

The browser is a separate process with fresh contexts and no user profile.
Routing validates HTTPS/public DNS for each fetch and browser redirect hop.
This is application-level filtering, not an OS sandbox or pinned proxy egress.
"""
import asyncio
import hmac
import ipaddress
from pathlib import Path
import socket
from urllib.parse import urljoin, urlsplit

from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field


class CrawlReadError(ValueError):
    """A fixed reader diagnostic; never a browser exception or response body."""


CRAWL_ERROR_CODES = frozenset({
    'public-https-required', 'dns-unavailable', 'public-address-required',
    'response-too-large', 'redirect-limit', 'navigation-failed',
    'extraction-failed', 'browser-failed', 'timeout',
})


def crawl_error_code(error, stage):
    if isinstance(error, CrawlReadError) and str(error) in CRAWL_ERROR_CODES:
        return str(error)
    if isinstance(error, TimeoutError) or type(error).__name__ == 'TimeoutError':
        return 'timeout'
    return {'browser': 'browser-failed', 'navigation': 'navigation-failed'}.get(stage, 'extraction-failed')


def crawl_error_headers(error, stage):
    return {
        'X-DeskPet-Crawl-Stage': stage if stage in ('browser', 'navigation', 'extraction') else 'extraction',
        'X-DeskPet-Crawl-Error': crawl_error_code(error, stage),
    }


def failed_crawl_result(result, requested_url, error_code='extraction-failed'):
    # Preserve upstream HTTP status even when Crawl4AI reports success=False.
    # Error text and the failed page's HTML/Markdown are never returned as content.
    status = getattr(result, 'status_code', None)
    return {'success': False, 'results': [{
        'success': False, 'url': requested_url,
        'status_code': status if type(status) is int and 100 <= status <= 599 else None,
        'error_code': error_code if error_code in CRAWL_ERROR_CODES else 'extraction-failed',
    }]}


async def public_url(value):
    try:
        parsed = urlsplit(value)
        host, port = parsed.hostname, parsed.port
    except ValueError:
        raise CrawlReadError('public-https-required') from None
    if len(value) > 2048 or parsed.scheme != 'https' or not host or parsed.username or parsed.password or port not in (None, 443):
        raise CrawlReadError('public-https-required')
    try:
        addresses = await asyncio.get_running_loop().getaddrinfo(host, 443, type=socket.SOCK_STREAM)
    except OSError as error:
        raise CrawlReadError('dns-unavailable') from error
    if not addresses:
        raise CrawlReadError('dns-unavailable')
    if any(not ipaddress.ip_address(record[4][0]).is_global for record in addresses):
        raise CrawlReadError('public-address-required')
    return value


class CrawlRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    urls: list[str] = Field(min_length=1, max_length=1)
    browser_config: dict | None = None
    crawler_config: dict | None = None


async def abort_blocked_route(route, page):
    # Closing a context cancels outstanding routes. A second abort then raises
    # TargetClosedError; the request cannot be continued in that closed target.
    if page.is_closed():
        return
    try:
        await route.abort()
    except Exception as error:
        if not page.is_closed() and type(error).__name__ != 'TargetClosedError':
            raise


def build_app(root: Path, proxy: str | None):
    from crawl4ai import AsyncWebCrawler, BrowserConfig, CacheMode, CrawlerRunConfig
    from crawl4ai.content_filter_strategy import PruningContentFilter
    from crawl4ai.markdown_generation_strategy import DefaultMarkdownGenerator

    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    token = (root / 'crawl4ai-token').read_text().strip()
    semaphore = asyncio.Semaphore(1)
    stats = {'completed': 0, 'failed': 0, 'blockedRequests': 0}
    observed_final = {}
    navigation_response = {}
    navigation_failure = {}

    async def response_data(response):
        if int(response.headers.get('content-length', '0')) > 4 * 1024 * 1024:
            raise CrawlReadError('response-too-large')
        body = await response.body()
        if len(body) > 4 * 1024 * 1024:
            raise CrawlReadError('response-too-large')
        headers = {key: value for key, value in response.headers.items() if key.lower() not in ('content-encoding', 'transfer-encoding', 'content-length')}
        return response.status, headers, body

    async def resolve_navigation(crawler, config, url):
        # Playwright route handlers do not reliably re-enter on browser-followed
        # redirects. Resolve the seed with an isolated API context and reuse its
        # final response for the browser's first navigation at the actual URL.
        context = await crawler.crawler_strategy.browser_manager.create_browser_context(config)
        try:
            for _ in range(4):
                await public_url(url)
                response = await context.request.get(url, max_redirects=0, timeout=20000)
                try:
                    if response.status in (301, 302, 303, 307, 308):
                        location = response.headers.get('location')
                        if not location:
                            raise CrawlReadError('redirect-limit')
                        url = await public_url(urljoin(url, location))
                        continue
                    navigation_response[url] = await response_data(response)
                    return url
                finally:
                    await response.dispose()
            raise CrawlReadError('redirect-limit')
        finally:
            await context.close()

    @app.get('/health')
    async def health():
        return {'service': 'deskpet-crawl4ai-trial', 'version': '0.9.5', 'ready': True, 'proxyConfigured': bool(proxy), **stats}

    async def on_browser(browser, **_):
        original_new_context = browser.new_context

        async def new_context(**kwargs):
            kwargs.update(service_workers='block', accept_downloads=False)
            context = await original_new_context(**kwargs)
            if hasattr(context, 'route_web_socket'):
                await context.route_web_socket('**/*', lambda websocket: websocket.close())
            return context

        browser.new_context = new_context

    async def on_page(page, context, **_):
        async def guard(route, request):
            main_navigation = request.is_navigation_request() and request.frame == page.main_frame
            try:
                if request.resource_type in ('image', 'media', 'font') or request.method not in ('GET', 'HEAD'):
                    stats['blockedRequests'] += 1
                    if main_navigation:
                        navigation_failure['code'] = 'navigation-failed'
                    await abort_blocked_route(route, page)
                    return
                destination = request.url
                if request.redirected_from is not None:
                    raise CrawlReadError('redirect-limit')
                await public_url(destination)
                cached = navigation_response.pop(destination, None) if main_navigation else None
                if cached is not None:
                    status, headers, body = cached
                else:
                    response = await route.fetch(url=destination, max_redirects=0, timeout=20000)
                    try:
                        if response.status in (301, 302, 303, 307, 308):
                            # Later navigations and redirected subresources are
                            # deliberately refused in this reading-only trial.
                            raise CrawlReadError('redirect-limit')
                        status, headers, body = await response_data(response)
                    finally:
                        await response.dispose()
                if main_navigation:
                    observed_final['url'] = destination
                await route.fulfill(status=status, headers=headers, body=body)
            except Exception as error:
                stats['blockedRequests'] += 1
                if main_navigation:
                    navigation_failure['code'] = crawl_error_code(error, 'navigation')
                await abort_blocked_route(route, page)

        await context.route('**/*', guard)
        return page

    @app.post('/crawl')
    async def crawl(payload: CrawlRequest, request: Request):
        supplied = request.headers.get('authorization', '')
        if not hmac.compare_digest(supplied, 'Bearer ' + token):
            raise HTTPException(401, 'local-token-required')
        if request.client and request.client.host not in ('127.0.0.1', '::1'):
            raise HTTPException(403, 'loopback-required')
        try:
            await public_url(payload.urls[0])
        except ValueError as error:
            raise HTTPException(400, 'public-https-required', headers=crawl_error_headers(error, 'navigation')) from None
        # Never deserialize caller-supplied Crawl4AI config. These two fields are
        # accepted solely for compatibility; all run/browser policy is fixed here.
        async with semaphore:
            stage = 'browser'
            try:
                observed_final.clear()
                navigation_response.clear()
                navigation_failure.clear()
                browser = BrowserConfig(headless=True, text_mode=False, accept_downloads=False, verbose=False,
                    proxy_config=proxy, extra_args=['--disable-extensions', '--disable-background-networking', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'])
                crawler = AsyncWebCrawler(config=browser, base_directory=str(root / 'crawler-data'))
                crawler.crawler_strategy.set_hook('on_browser_created', on_browser)
                crawler.crawler_strategy.set_hook('on_page_context_created', on_page)
                config = CrawlerRunConfig(cache_mode=CacheMode.BYPASS, page_timeout=40000, wait_until='domcontentloaded', delay_before_return_html=1.0,
                    markdown_generator=DefaultMarkdownGenerator(content_filter=PruningContentFilter(threshold=0.48, threshold_type='fixed')),
                    verbose=False)
                async def read_page():
                    nonlocal stage
                    async with crawler:
                        stage = 'navigation'
                        final_url = await resolve_navigation(crawler, config, payload.urls[0])
                        stage = 'extraction'
                        return await crawler.arun(final_url, config=config)
                result = await asyncio.wait_for(read_page(), timeout=50)
                status = getattr(result, 'status_code', None)
                if navigation_failure or not result.success or (type(status) is int and status >= 400):
                    stats['failed'] += 1
                    return failed_crawl_result(result, payload.urls[0], navigation_failure.get('code', 'extraction-failed'))
                markdown = result.markdown
                output = {'success': True, 'results': [{'success': True, 'url': result.url,
                    'redirected_url': observed_final.get('url') or getattr(result, 'redirected_url', None) or result.url,
                    'html': result.html[:2_000_000], 'status_code': result.status_code,
                    'markdown': {'raw_markdown': markdown.raw_markdown[:1_000_000], 'fit_markdown': (markdown.fit_markdown or '')[:1_000_000]}}]}
                stats['completed'] += 1
                return output
            except Exception as error:
                stats['failed'] += 1
                raise HTTPException(502, 'crawl-failed', headers=crawl_error_headers(error, stage)) from None
            finally:
                navigation_response.clear()

    return app
