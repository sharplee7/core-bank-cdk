#!/usr/bin/env bash
#
# Node 20 을 보장한 뒤 이 CDK를 배포한다.
# 부트스트랩 EC2(cdk-deploy)의 UserData나, 이미 떠 있는 EC2에서 수동으로도 그대로 쓴다.
#
#   bash scripts/deploy.sh
#
# 이 스크립트가 하는 일:
#   1) 현재 node 메이저 버전 확인 -> 20 미만이면 Node 20 자동 설치 (yum/dnf, 실패시 nvm)
#   2) node_modules 재설치 (구버전 node로 깔린 것 정리)
#   3) cdk bootstrap + cdk deploy
#
# 근본 이유: aws-cdk CLI 번들 WASM(cdk-from-cfn)이 externref 를 써서 Node 16/18에서는
# `npx cdk` 가 `CompileError: WebAssembly.Module(): invalid value type 'externref'` 로 즉시 죽는다.

set -uo pipefail

REQUIRED_MAJOR=20

node_major() {
  command -v node >/dev/null 2>&1 || { echo 0; return; }
  node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1
}

# sudo 가 없으면(=이미 root) 그냥 실행
SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  command -v sudo >/dev/null 2>&1 && SUDO="sudo"
fi

install_node20() {
  echo ">> Node $(node_major) 감지 -> Node ${REQUIRED_MAJOR} 설치 시도"
  if command -v dnf >/dev/null 2>&1; then
    $SUDO dnf remove -y nodejs nodejs20 >/dev/null 2>&1 || true
    $SUDO bash -c 'curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -'
    $SUDO dnf clean all || true
    $SUDO dnf install -y nodejs && { hash -r; return 0; }
  elif command -v yum >/dev/null 2>&1; then
    # 이미 설치된 nodejs 16 을 지워야 "already installed" 로 넘어가지 않는다
    $SUDO yum remove -y nodejs >/dev/null 2>&1 || true
    $SUDO bash -c 'curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -'
    $SUDO yum clean all || true
    $SUDO yum install -y nodejs && { hash -r; return 0; }
  fi

  echo ">> 패키지 매니저 경로 실패 -> nvm 으로 대체"
  export NVM_DIR="$HOME/.nvm"
  curl -fsSL -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
  # shellcheck disable=SC1090
  . "$NVM_DIR/nvm.sh"
  nvm install 20 && nvm use 20 && nvm alias default 20
  hash -r
}

if [ "$(node_major)" -lt "$REQUIRED_MAJOR" ]; then
  install_node20
fi

echo ">> 사용 중인 node: $(node -v 2>/dev/null || echo 'none'), npm: $(npm -v 2>/dev/null || echo 'none')"
if [ "$(node_major)" -lt "$REQUIRED_MAJOR" ]; then
  echo "ERROR: Node ${REQUIRED_MAJOR}+ 가 필요하지만 $(node -v 2>/dev/null) 입니다. 설치가 실패했습니다." >&2
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
