"""Local, in-memory regression; no browser, service, network or credential."""
import asyncio
from pathlib import Path
import socket
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, MagicMock, Mock, patch

from fastapi import HTTPException

from crawler_service import (
    CrawlReadError, CrawlRequest, abort_blocked_route, build_app,
    crawl_error_headers, failed_crawl_result, public_url,
)


class TargetClosedError(Exception):
    pass


class BlockedRouteTests(unittest.IsolatedAsyncioTestCase):
    async def test_closed_before_abort(self):
        route = Mock(abort=AsyncMock())
        await abort_blocked_route(route, Mock(is_closed=Mock(return_value=True)))
        route.abort.assert_not_awaited()

    async def test_close_during_abort_does_not_mask_a_live_route_error(self):
        route = Mock(abort=AsyncMock(side_effect=TargetClosedError()))
        await abort_blocked_route(route, Mock(is_closed=Mock(return_value=False)))
        route.abort.side_effect = RuntimeError('fixture')
        with self.assertRaises(RuntimeError):
            await abort_blocked_route(route, Mock(is_closed=Mock(return_value=False)))


class PublicTargetTests(unittest.IsolatedAsyncioTestCase):
    async def test_dns_failure_is_distinct_from_mixed_public_private_addresses(self):
        loop = asyncio.get_running_loop()
        records = [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('93.184.216.34', 443)),
                   (socket.AF_INET, socket.SOCK_STREAM, 6, '', ('10.1.2.3', 443))]
        with patch.object(loop, 'getaddrinfo', new=AsyncMock(return_value=records)):
            with self.assertRaisesRegex(CrawlReadError, '^public-address-required$'):
                await public_url('https://example.org/mixed')
        with patch.object(loop, 'getaddrinfo', new=AsyncMock(side_effect=socket.gaierror('PRIVATE_DNS_ERROR'))):
            with self.assertRaisesRegex(CrawlReadError, '^dns-unavailable$'):
                await public_url('https://example.org/unresolved')
        with patch.object(loop, 'getaddrinfo', new=AsyncMock(return_value=[])):
            with self.assertRaisesRegex(CrawlReadError, '^dns-unavailable$'):
                await public_url('https://example.org/empty-dns')

    async def test_invalid_targets_are_rejected_without_dns(self):
        with patch.object(asyncio.get_running_loop(), 'getaddrinfo', new=AsyncMock()) as resolve:
            for url in ('http://example.org/', 'https://example.org:8443/',
                        'https://user:secret@example.org/', 'https://example.org:invalid/'):
                with self.subTest(url=url), self.assertRaisesRegex(CrawlReadError, '^public-https-required$'):
                    await public_url(url)
            resolve.assert_not_awaited()

    async def test_public_https_still_passes_the_same_address_check(self):
        records = [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('93.184.216.34', 443))]
        with patch.object(asyncio.get_running_loop(), 'getaddrinfo', new=AsyncMock(return_value=records)):
            self.assertEqual(await public_url('https://example.org/page'), 'https://example.org/page')


class ErrorDiagnosticTests(unittest.TestCase):
    def test_fixed_codes_are_preserved_without_raw_exception_details(self):
        self.assertEqual(crawl_error_headers(CrawlReadError('dns-unavailable'), 'navigation'), {
            'X-DeskPet-Crawl-Stage': 'navigation', 'X-DeskPet-Crawl-Error': 'dns-unavailable'})
        for stage, code in (('browser', 'browser-failed'), ('navigation', 'navigation-failed'), ('extraction', 'extraction-failed')):
            with self.subTest(stage=stage):
                headers = crawl_error_headers(RuntimeError('PRIVATE_URL_AND_CREDENTIAL'), stage)
                self.assertEqual(headers['X-DeskPet-Crawl-Error'], code)
                self.assertNotIn('PRIVATE_', str(headers))
        self.assertEqual(crawl_error_headers(TimeoutError('PRIVATE_TIMEOUT'), 'navigation')['X-DeskPet-Crawl-Error'], 'timeout')
        self.assertEqual(crawl_error_headers(CrawlReadError('PRIVATE_UNKNOWN_CODE'), 'PRIVATE_STAGE'), {
            'X-DeskPet-Crawl-Stage': 'extraction', 'X-DeskPet-Crawl-Error': 'extraction-failed'})

    def test_failed_http_page_is_not_returned_as_readable_content(self):
        result = failed_crawl_result(SimpleNamespace(status_code=404, html='PRIVATE_ERROR_PAGE', error_message='PRIVATE_ERROR'), 'https://example.org/missing')
        self.assertEqual(result, {'success': False, 'results': [{'success': False,
            'url': 'https://example.org/missing', 'status_code': 404, 'error_code': 'extraction-failed'}]})
        self.assertNotIn('PRIVATE_', str(result))


def adapter_fixture(result=None):
    """Call the real FastAPI handler with in-memory browser and token doubles."""
    response = SimpleNamespace(status=200, headers={'content-type': 'text/html'},
        body=AsyncMock(return_value=b'<p>synthetic content</p>'), dispose=AsyncMock())
    api_context = SimpleNamespace(request=SimpleNamespace(get=AsyncMock(return_value=response)), close=AsyncMock())
    hooks = {}
    crawler = MagicMock()
    crawler.__aenter__ = AsyncMock(return_value=crawler)
    crawler.__aexit__ = AsyncMock(return_value=False)
    crawler.crawler_strategy.set_hook.side_effect = lambda name, callback: hooks.update({name: callback})
    crawler.crawler_strategy.browser_manager.create_browser_context = AsyncMock(return_value=api_context)
    crawler.arun = AsyncMock(return_value=result or SimpleNamespace(success=True, status_code=200,
        url='https://example.org/page', html='<p>synthetic content</p>',
        markdown=SimpleNamespace(raw_markdown='synthetic content', fit_markdown='synthetic content')))
    modules = {
        'crawl4ai': SimpleNamespace(AsyncWebCrawler=Mock(return_value=crawler), BrowserConfig=Mock(),
            CacheMode=SimpleNamespace(BYPASS='synthetic-bypass'), CrawlerRunConfig=Mock()),
        'crawl4ai.content_filter_strategy': SimpleNamespace(PruningContentFilter=Mock()),
        'crawl4ai.markdown_generation_strategy': SimpleNamespace(DefaultMarkdownGenerator=Mock()),
    }
    root = MagicMock(spec=Path)
    (root / 'crawl4ai-token').read_text.return_value = 'SYNTHETIC_LOCAL_ONLY'
    with patch.dict(sys.modules, modules):
        app = build_app(root, None)
    endpoint = next(route.endpoint for route in app.routes if route.path == '/crawl')
    request = SimpleNamespace(headers={'authorization': 'Bearer SYNTHETIC_LOCAL_ONLY'}, client=SimpleNamespace(host='127.0.0.1'))
    return SimpleNamespace(endpoint=endpoint, payload=CrawlRequest(urls=['https://example.org/page']), request=request,
        crawler=crawler, api_context=api_context, response=response, hooks=hooks)


class AdapterDiagnosticTests(unittest.IsolatedAsyncioTestCase):
    async def test_seed_security_failure_is_fixed_and_never_starts_the_browser(self):
        f = adapter_fixture()
        with patch('crawler_service.public_url', new=AsyncMock(side_effect=CrawlReadError('public-address-required'))):
            with self.assertRaises(HTTPException) as caught:
                await f.endpoint(f.payload, f.request)
        self.assertEqual(caught.exception.status_code, 400)
        self.assertEqual(caught.exception.headers['X-DeskPet-Crawl-Error'], 'public-address-required')
        f.crawler.__aenter__.assert_not_awaited()

    async def test_browser_navigation_and_extraction_failures_have_distinct_headers(self):
        for stage in ('browser', 'navigation', 'extraction'):
            with self.subTest(stage=stage):
                f = adapter_fixture()
                failure = RuntimeError('PRIVATE_BROWSER_DETAILS')
                target = {'browser': f.crawler.__aenter__, 'navigation': f.api_context.request.get, 'extraction': f.crawler.arun}[stage]
                target.side_effect = failure
                with patch('crawler_service.public_url', new=AsyncMock(side_effect=lambda value: value)):
                    with self.assertRaises(HTTPException) as caught:
                        await f.endpoint(f.payload, f.request)
                self.assertEqual(caught.exception.status_code, 502)
                self.assertEqual(caught.exception.headers['X-DeskPet-Crawl-Stage'], stage)
                self.assertEqual(caught.exception.headers['X-DeskPet-Crawl-Error'], stage + '-failed')
                self.assertNotIn('PRIVATE_', str(caught.exception.detail) + str(caught.exception.headers))

    async def test_http_error_status_survives_both_success_and_failure_flags(self):
        for success in (True, False):
            with self.subTest(success=success):
                f = adapter_fixture(SimpleNamespace(success=success, status_code=404, html='PRIVATE_ERROR_HTML', error_message='PRIVATE_ERROR'))
                with patch('crawler_service.public_url', new=AsyncMock(side_effect=lambda value: value)):
                    result = await f.endpoint(f.payload, f.request)
                self.assertFalse(result['success'])
                self.assertEqual(result['results'][0]['status_code'], 404)
                self.assertNotIn('PRIVATE_', str(result))

    async def test_blocked_main_navigation_cannot_become_a_successful_source(self):
        f = adapter_fixture()
        page = SimpleNamespace(main_frame=object(), is_closed=Mock(return_value=False))
        request = SimpleNamespace(resource_type='document', method='GET', redirected_from=None,
            url='https://example.org/page', frame=page.main_frame, is_navigation_request=Mock(return_value=True))
        route = SimpleNamespace(abort=AsyncMock(), fulfill=AsyncMock())
        handlers = {}
        context = SimpleNamespace(route=AsyncMock(side_effect=lambda pattern, callback: handlers.update({pattern: callback})))
        success_result = f.crawler.arun.return_value

        async def simulate_navigation(*_args, **_kwargs):
            await f.hooks['on_page_context_created'](page, context)
            await handlers['**/*'](route, request)
            return success_result

        f.crawler.arun.side_effect = simulate_navigation
        with patch('crawler_service.public_url', new=AsyncMock(side_effect=[f.payload.urls[0], f.payload.urls[0], CrawlReadError('public-address-required')])):
            result = await f.endpoint(f.payload, f.request)
        self.assertFalse(result['success'])
        self.assertEqual(result['results'][0]['error_code'], 'public-address-required')
        route.abort.assert_awaited_once()
        route.fulfill.assert_not_awaited()


if __name__ == '__main__':
    unittest.main()
