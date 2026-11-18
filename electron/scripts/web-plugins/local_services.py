#!/usr/bin/env python3
"""Private local trial launcher. No installs, login items or paid services.

Requires a prepared runtime root (venv, pinned searxng checkout, browsers).
Only stops process groups whose PID/start-time/command match this launcher's record.
"""
import argparse
import json
import os
from pathlib import Path
import secrets
import signal
import socket
import subprocess
import sys
import time
import urllib.parse


SCRIPT = Path(__file__).resolve()


def proxy_url():
    for name in ('HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy'):
        value = os.environ.get(name)
        if value:
            parsed = urllib.parse.urlsplit(value)
            if parsed.scheme in ('http', 'https', 'socks5') and parsed.hostname:
                return value
    if sys.platform == 'darwin':
        text = subprocess.run(['/usr/sbin/scutil', '--proxy'], text=True, capture_output=True, check=True).stdout
        settings = {}
        for line in text.splitlines():
            if ' : ' in line:
                key, value = line.strip().split(' : ', 1)
                settings[key] = value
        for prefix in ('HTTPS', 'HTTP'):
            if settings.get(prefix + 'Enable') == '1' and settings.get(prefix + 'Proxy'):
                return 'http://' + settings[prefix + 'Proxy'] + ':' + settings.get(prefix + 'Port', '8080')
    return None


def environment(root):
    env = dict(os.environ)
    env.update({
        'PYTHONPATH': str(root / 'searxng'),
        'PYTHONDONTWRITEBYTECODE': '1',
        'SEARXNG_SETTINGS_PATH': str(root / 'searxng-settings.yml'),
        'SEARXNG_BIND_ADDRESS': '127.0.0.1',
        'SEARXNG_PORT': '8080',
        'PLAYWRIGHT_BROWSERS_PATH': str(root / 'browsers'),
        'CRAWL4_AI_BASE_DIRECTORY': str(root / 'crawler-data'),
        'XDG_CACHE_HOME': str(root / 'cache'),
        'XDG_DATA_HOME': str(root / 'data'),
        'HF_HOME': str(root / 'models'),
        'UV_CACHE_DIR': str(root / 'uv-cache'),
    })
    for directory in ('crawler-data', 'cache', 'data', 'models', 'logs'):
        (root / directory).mkdir(mode=0o700, exist_ok=True)
    return env


def prepare(root):
    import yaml
    token_path = root / 'crawl4ai-token'
    if not token_path.exists():
        descriptor = os.open(token_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, 'w') as stream:
            stream.write(secrets.token_urlsafe(32))
    os.chmod(token_path, 0o600)
    settings_path = root / 'searxng-settings.yml'
    if not settings_path.exists():
        config = {
            'use_default_settings': {'engines': {'keep_only': ['brave', 'yahoo', 'mojeek']}},
            'general': {'instance_name': 'DeskPet Local Search', 'enable_metrics': False},
            'server': {'secret_key': secrets.token_hex(32), 'bind_address': '127.0.0.1', 'port': 8080, 'limiter': False, 'public_instance': False},
            'search': {'formats': ['json'], 'autocomplete': '', 'default_lang': 'all'},
            'outgoing': {'request_timeout': 8.0, 'max_request_timeout': 12.0},
            'engines': [{'name': name, 'disabled': False} for name in ['brave', 'yahoo', 'mojeek']],
            'valkey': {'url': False},
        }
        with open(settings_path, 'x', encoding='utf8') as stream:
            yaml.safe_dump(config, stream, allow_unicode=True)
        os.chmod(settings_path, 0o600)
    config = yaml.safe_load(settings_path.read_text())
    proxy = proxy_url()
    if proxy:
        config.setdefault('outgoing', {})['proxies'] = {'all://': [proxy]}
    else:
        config.setdefault('outgoing', {}).pop('proxies', None)
    settings_path.write_text(yaml.safe_dump(config, allow_unicode=True))
    os.chmod(settings_path, 0o600)
    # Locales are source assets; compilation writes only the prepared runtime checkout.
    if not (root / 'searxng/searx/translations/zh_Hans_CN/LC_MESSAGES/messages.mo').exists():
        with open(root / 'logs/locales.log', 'a') as log:
            subprocess.run([str(root / 'venv/bin/pybabel'), 'compile', '-d', str(root / 'searxng/searx/translations')], stdout=log, stderr=log, check=True)
    return bool(proxy)


def process_identity(pid):
    try:
        value = subprocess.run(['/bin/ps', '-p', str(pid), '-o', 'lstart=', '-o', 'command='], text=True, capture_output=True, check=True).stdout.strip()
        return value or None
    except (OSError, subprocess.CalledProcessError):
        return None


def owned(record, root):
    pid = record.get('pid')
    try:
        return isinstance(pid, int) and process_identity(pid) == record.get('identity') and str(SCRIPT) in record.get('identity', '') and str(root) in record.get('identity', '') and os.getpgid(pid) == pid
    except OSError:
        return False


def group_members(pgid):
    """Private identity snapshot for the exact group; never expose other process metadata."""
    try:
        lines = subprocess.run(['/bin/ps', '-ax', '-o', 'pid=', '-o', 'pgid=', '-o', 'lstart=', '-o', 'command='], text=True, capture_output=True, check=True).stdout.splitlines()
    except (OSError, subprocess.CalledProcessError):
        return None
    members = {}
    for line in lines:
        parts = line.strip().split(None, 2)
        if len(parts) == 3 and parts[0].isdigit() and parts[1].isdigit() and int(parts[1]) == pgid:
            members[int(parts[0])] = parts[2]
    return members


def service_status(root):
    records_path = root / 'services.json'
    records = json.loads(records_path.read_text()) if records_path.exists() else {}
    result = {}
    for kind, port in [('searxng', 8080), ('crawl4ai', 11235)]:
        record = records.get(kind, {})
        alive = False
        try:
            alive = owned(record, root)
        except ProcessLookupError:
            pass
        listening = False
        try:
            with socket.create_connection(('127.0.0.1', port), timeout=0.2):
                listening = True
        except OSError:
            pass
        result[kind] = {'ownedProcessRunning': alive, 'port': port, 'listening': listening, 'pid': record.get('pid') if alive else None}
    return result


def start(root):
    environment(root)
    proxy = prepare(root)
    path = root / 'services.json'
    records = json.loads(path.read_text()) if path.exists() else {}
    for kind, port in [('searxng', 8080), ('crawl4ai', 11235)]:
        current = records.get(kind, {})
        if current and owned(current, root):
            continue
        with socket.socket() as check:
            try:
                check.bind(('127.0.0.1', port))
            except OSError as error:
                raise RuntimeError(f'{kind}: port {port} is already in use; no process was stopped') from error
        with open(root / f'logs/{kind}.log', 'a') as log:
            child = subprocess.Popen([str(root / 'venv/bin/python'), str(SCRIPT), 'serve', '--kind', kind, '--runtime-root', str(root)], cwd=root, env=environment(root), stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
        time.sleep(0.15)
        identity = process_identity(child.pid)
        if not identity:
            raise RuntimeError(f'{kind}: startup exited; see its local log')
        records[kind] = {'pid': child.pid, 'identity': identity, 'startedAt': time.time()}
        path.write_text(json.dumps(records, indent=2))
        os.chmod(path, 0o600)
    deadline = time.monotonic() + 20
    while True:
        current_status = service_status(root)
        if all(item['ownedProcessRunning'] and item['listening'] for item in current_status.values()):
            break
        if time.monotonic() >= deadline or any(not item['ownedProcessRunning'] for item in current_status.values()):
            raise RuntimeError('local service startup did not become ready; inspect runtime/logs without discarding prior failures')
        time.sleep(0.2)
    print(json.dumps({'status': current_status, 'proxyConfigured': proxy, 'tokenStored': True}, ensure_ascii=False))


def stop(root):
    path = root / 'services.json'
    records = json.loads(path.read_text()) if path.exists() else {}
    result = {}
    for kind, record in records.items():
        if not owned(record, root):
            result[kind] = 'not-owned-or-exited'
            continue
        pid = record['pid']
        initial = group_members(pid)
        if initial is None or pid not in initial or not owned(record, root):
            result[kind] = 'not-owned-or-exited'
            continue
        try:
            os.killpg(pid, signal.SIGTERM)
        except ProcessLookupError:
            result[kind] = 'stopped-owned-group'
            continue
        remaining = initial
        for _ in range(40):
            remaining = group_members(pid)
            if not remaining:
                break
            time.sleep(0.1)
        if remaining:
            # The leader may have exited already. A surviving member with the
            # same PID/start-time/command still proves this is our original
            # group, rather than a reused PID belonging to an unrelated job.
            if not any(initial.get(member) == identity for member, identity in remaining.items()):
                result[kind] = 'stop-unconfirmed'
                continue
            try:
                os.killpg(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            for _ in range(20):
                remaining = group_members(pid)
                if not remaining:
                    break
                time.sleep(0.1)
        result[kind] = 'stopped-owned-group' if remaining == {} else 'stop-unconfirmed'
    print(json.dumps(result))


def serve(root, kind):
    os.environ.update(environment(root))
    if kind == 'searxng':
        os.chdir(root / 'searxng')
        from searx.webapp import app
        app.run(host='127.0.0.1', port=8080, debug=False, use_reloader=False, threaded=True)
    else:
        from crawler_service import build_app
        import uvicorn
        uvicorn.run(build_app(root, proxy_url()), host='127.0.0.1', port=11235, access_log=False, log_level='warning')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['start', 'stop', 'status', 'serve'])
    parser.add_argument('--runtime-root', required=True, type=Path)
    parser.add_argument('--kind', choices=['searxng', 'crawl4ai'])
    args = parser.parse_args()
    root = args.runtime_root.resolve(strict=True)
    if not (root / 'venv/bin/python').exists() or not (root / 'searxng/.git').exists():
        parser.error('runtime root must contain the prepared venv and SearXNG checkout')
    if args.command == 'start':
        start(root)
    elif args.command == 'stop':
        stop(root)
    elif args.command == 'status':
        print(json.dumps(service_status(root)))
    elif args.kind:
        serve(root, args.kind)
    else:
        parser.error('serve needs --kind')


if __name__ == '__main__':
    main()
