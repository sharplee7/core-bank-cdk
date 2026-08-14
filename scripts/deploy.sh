#!/usr/bin/env bash
#
# Node 20 을 보장한 뒤 이 CDK를 배포한다.
# 부트스트랩 EC2(cdk-deploy)의 UserData나, 이미 떠 있는 EC2에서 수동으로도 그대로 쓴다.
#
#   bash scripts/deploy.sh
#
# 이 스크립트가 하는 일:
#   1) 현재 node 확인 -> 20 미만/실행불가면 Node 20 설치
#      - glibc >= 2.28 (예: Amazon Linux 2023): nodesource 표준 패키지
#      - glibc <  2.28 (예: Amazon Linux 2, glibc 2.26): glibc-217 비공식 빌드
#        (표준 Node 18/20 바이너리는 glibc 2.28+ 를 요구해 AL2에서는 실행조차 안 된다)
#   2) node_modules 재설치
#   3) cdk bootstrap + cdk deploy
#
# 근본 이유: aws-cdk CLI 번들 WASM(cdk-from-cfn)이 externref 를 써서 Node 16/18에서는
# `npx cdk` 가 `CompileError: WebAssembly.Module(): invalid value type 'externref'` 로 즉시 죽는다.

set -uo pipefail

REQUIRED_MAJOR=20
NODE_VER="v20.20.2"

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  command -v sudo >/dev/null 2>&1 && SUDO="sudo"
fi

# node 가 없거나, 있어도 실행이 안 되면(예: glibc 불일치) 0 을 돌려준다.
node_major() {
  local v
  v=$(node -v 2>/dev/null) || { echo 0; return; }
  [ -z "$v" ] && { echo 0; return; }
  echo "${v#v}" | cut -d. -f1
}

# glibc >= 2.28 이면 0(true)
glibc_ge_228() {
  local g maj min
  g=$(ldd --version 2>/dev/null | awk 'NR==1{print $NF}')
  [ -z "$g" ] && return 1
  maj=${g%%.*}; min=${g#*.}; min=${min%%.*}
  [ "$maj" -gt 2 ] && return 0
  [ "$maj" -eq 2 ] && [ "$min" -ge 28 ] && return 0
  return 1
}

install_via_pkg() {
  echo ">> Node ${REQUIRED_MAJOR} 설치 (nodesource 표준 패키지)"
  if command -v dnf >/dev/null 2>&1; then
    $SUDO dnf remove -y nodejs nodejs20 >/dev/null 2>&1 || true
    $SUDO bash -c 'curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -'
    $SUDO dnf install -y nodejs
  else
    # 이미 설치된 구버전(node16 등)을 지워야 "already installed" 로 넘어가지 않는다
    $SUDO yum remove -y nodejs >/dev/null 2>&1 || true
    $SUDO bash -c 'curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -'
    $SUDO yum clean all || true
    $SUDO yum install -y nodejs
  fi
  hash -r
}

install_glibc217() {
  echo ">> glibc<2.28 감지 -> Node ${NODE_VER} (glibc-217 비공식 빌드) 를 /usr/local 에 설치"
  # 충돌 방지로 패키지 매니저 node 는 제거
  $SUDO yum remove -y nodejs >/dev/null 2>&1 || $SUDO dnf remove -y nodejs >/dev/null 2>&1 || true
  local url="https://unofficial-builds.nodejs.org/download/release/${NODE_VER}/node-${NODE_VER}-linux-x64-glibc-217.tar.gz"
  curl -fsSL -o /tmp/node20-glibc217.tar.gz "$url"
  $SUDO tar -xzf /tmp/node20-glibc217.tar.gz -C /usr/local --strip-components=1
  # /usr/local/bin 이 (nvm 등) 다른 node 보다 우선하도록
  export PATH="/usr/local/bin:$PATH"
  hash -r
}

if [ "$(node_major)" -lt "$REQUIRED_MAJOR" ]; then
  if glibc_ge_228; then
    install_via_pkg
    # 표준 패키지를 깔았는데도 glibc 로 실행이 안 되면 비공식 빌드로 폴백
    [ "$(node_major)" -lt "$REQUIRED_MAJOR" ] && install_glibc217
  else
    install_glibc217
  fi
fi

echo ">> node: $(node -v 2>/dev/null || echo none), npm: $(npm -v 2>/dev/null || echo none)"
if [ "$(node_major)" -lt "$REQUIRED_MAJOR" ]; then
  echo "ERROR: Node ${REQUIRED_MAJOR}+ 설치에 실패했습니다." >&2
  exit 1
fi

# 리포 루트로 이동 (이 스크립트 위치 기준)
cd "$(dirname "$0")/.."

echo ">> 의존성 재설치"
rm -rf node_modules package-lock.json
npm i

echo ">> cdk bootstrap"
npx cdk bootstrap

echo ">> cdk deploy"
npx cdk deploy --require-approval never
