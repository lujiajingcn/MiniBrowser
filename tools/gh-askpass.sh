#!/bin/bash
# GIT_ASKPASS 辅助脚本：向 git 提供 GitHub 凭据。
#
# 为什么需要它：
#   本机代理对 github.com 主域名的 CONNECT 隧道返回 502（api/raw/codeload
#   等子域都正常），所以推送必须改走 https://ghproxy.net/https://github.com/...
#   但 Git Credential Manager 是按**请求 URL 的主机名**查凭据的，改写后它会去
#   找 "git:https://ghproxy.net/..." 这个键，而 Windows 凭据管理器里存的
#   是 "git:https://github.com"（用户 lujiajingcn）—— 于是认证失败。
#
#   本脚本让 git 通过 askpass 回调拿凭据，且在脚本内部用原始 host=github.com
#   去问 GCM，因此凭据查找路径与平时完全一致。
#   令牌不会出现在命令行参数里，也不会打印到日志。
case "$1" in
  *Username*)
    printf '%s\n' "lujiajingcn"
    ;;
  *Password*)
    printf 'protocol=https\nhost=github.com\n\n' \
      | git credential fill 2>/dev/null \
      | sed -n 's/^password=//p'
    ;;
  *)
    exit 1
    ;;
esac
