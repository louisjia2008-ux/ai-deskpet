#!/usr/bin/env python3
"""Public-only smoke queries; stores bounded receipts without local credentials."""
import argparse
import datetime
import hashlib
import json
from pathlib import Path
import time

import httpx


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime-root', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    root = args.runtime_root.resolve(strict=True)
    receipt = {'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'searches': [], 'reads': [], 'boundaries': []}
    args.output.parent.mkdir(parents=True, exist_ok=True)

    def save():
        args.output.write_text(json.dumps(receipt, indent=2, ensure_ascii=False))

    with httpx.Client(trust_env=False, timeout=65) as client:
        for query in ['Crawl4AI official documentation', 'Crawl4AI 中文 文档', 'Los Angeles weather today', '洛杉矶 今天天气']:
            start = time.monotonic()
            try:
                response = client.get('http://127.0.0.1:8080/search', params={'q': query, 'format': 'json', 'categories': 'general'})
                result = {'query': query, 'httpStatus': response.status_code, 'seconds': round(time.monotonic() - start, 2)}
                if response.is_success:
                    data = response.json()
                    result.update(resultCount=len(data.get('results', [])), unresponsiveEngines=data.get('unresponsive_engines', []),
                        samples=[{'title': item.get('title', '')[:180], 'url': item.get('url', '')[:1000], 'snippet': item.get('content', '')[:300], 'engines': item.get('engines', [])} for item in data.get('results', [])[:3]])
                receipt['searches'].append(result)
            except Exception as error:
                receipt['searches'].append({'query': query, 'failureClass': type(error).__name__, 'seconds': round(time.monotonic() - start, 2)})
            save()
        token = (root / 'crawl4ai-token').read_text().strip()
        headers = {'authorization': 'Bearer ' + token}
        for url in ['https://docs.crawl4ai.com/', 'https://www.weather.gov/lox/']:
            start = time.monotonic()
            try:
                response = client.post('http://127.0.0.1:11235/crawl', headers=headers, json={'urls': [url]})
                result = {'url': url, 'httpStatus': response.status_code, 'seconds': round(time.monotonic() - start, 2)}
                if response.is_success:
                    data = response.json(); item = (data.get('results') or [{}])[0]
                    markdown = item.get('markdown', {})
                    text = markdown.get('fit_markdown') or markdown.get('raw_markdown') or ''
                    result.update(success=data.get('success') and item.get('success'), characters=len(text), sourceSHA256=hashlib.sha256(text.encode()).hexdigest(), excerpt=text[:500], statusCode=item.get('status_code'))
                receipt['reads'].append(result)
            except Exception as error:
                receipt['reads'].append({'url': url, 'failureClass': type(error).__name__, 'seconds': round(time.monotonic() - start, 2)})
            save()
        for name, supplied_headers, payload in [('unauthenticated', {}, {'urls': ['https://example.com/']}), ('private-target', headers, {'urls': ['https://127.0.0.1/']}), ('arbitrary-hooks', headers, {'urls': ['https://example.com/'], 'hooks': {'before_goto': 'bad'}})]:
            response = client.post('http://127.0.0.1:11235/crawl', headers=supplied_headers, json=payload)
            receipt['boundaries'].append({'case': name, 'httpStatus': response.status_code})
            save()
        receipt['crawlerHealth'] = client.get('http://127.0.0.1:11235/health').json()
        save()
    print(json.dumps({'receipt': str(args.output), 'searchCounts': [item.get('resultCount') for item in receipt['searches']], 'readSuccess': [item.get('success', False) for item in receipt['reads']], 'boundaries': receipt['boundaries']}, ensure_ascii=False))


if __name__ == '__main__':
    main()
