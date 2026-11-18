#!/bin/bash
# TypeSafe System One 调试脚本：从 Keychain 读取 key，调用评估端点
# 用法:
#   ./scripts/typesafe_eval.sh @state.json @questions.json
# 只接受 @file 形式，避免把私密输入放进进程参数。

set -euo pipefail
umask 077

if [ "$#" -ne 2 ] || [[ "$1" != @* ]] || [[ "$2" != @* ]]; then
  sed -n '2,5p' "$0" >&2
  exit 1
fi

STATE_FILE="${1#@}"
QUESTIONS_FILE="${2#@}"
if [ ! -f "$STATE_FILE" ] || [ ! -r "$STATE_FILE" ] || [ ! -f "$QUESTIONS_FILE" ] || [ ! -r "$QUESTIONS_FILE" ]; then
  echo "错误: state/questions 必须是可读的普通文件" >&2
  exit 1
fi

PRIVATE_TEMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/deskpet-typesafe.XXXXXX")
REQUEST_FILE="$PRIVATE_TEMP_DIR/request.json"
RESPONSE_FILE="$PRIVATE_TEMP_DIR/response.json"
cleanup() {
  KEY=""
  rm -f "$REQUEST_FILE" "$RESPONSE_FILE"
  rmdir "$PRIVATE_TEMP_DIR" 2>/dev/null || true
}
trap cleanup EXIT INT TERM HUP

KEY=$(security find-generic-password -a "$USER" -s "typesafe-api-key" -w 2>/dev/null) || {
  echo "错误: Keychain 中未找到 typesafe-api-key，先运行:" >&2
  echo "  security add-generic-password -a \"\$USER\" -s \"typesafe-api-key\" -w" >&2
  exit 1
}
[ -n "$KEY" ] || { echo "错误: Keychain 中的 key 为空" >&2; exit 1; }

jq -n --rawfile state "$STATE_FILE" --slurpfile questions "$QUESTIONS_FILE" \
  'if ($questions | length) == 1 then
     {state: $state, model: "jev-latest", questions: $questions[0]}
   else
     error("questions must contain exactly one JSON value")
   end' >"$REQUEST_FILE" \
  || { echo "错误: questions 不是单个合法 JSON 值" >&2; exit 1; }

HTTP_CODE=$({
  printf 'header = "Authorization: Bearer %s"\n' "$KEY"
  printf 'header = "Content-Type: application/json"\n'
} | curl --silent --show-error --proto '=https' --tlsv1.2 --max-time 30 \
  --config - \
  --output "$RESPONSE_FILE" --write-out '%{http_code}' \
  --data-binary "@$REQUEST_FILE" \
  https://api.typesafe.ai/v1/systemone)
KEY=""

case "$HTTP_CODE" in
  200) jq . "$RESPONSE_FILE" ;;
  401) echo "错误 401: key 无效或已过期" >&2 ;;
  429|529) echo "错误 $HTTP_CODE: 限流/过载，稍后重试" >&2 ;;
  *) echo "错误 HTTP $HTTP_CODE（响应体未输出，以避免泄露请求内容）" >&2 ;;
esac
[ "$HTTP_CODE" = "200" ] || exit 1
