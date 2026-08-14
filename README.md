
# Welcome to your CDK TypeScript project

This is a blank project for CDK development with TypeScript.

The `cdk.json` file tells the CDK Toolkit how to execute your app.

## Useful commands

* `npm run build`   compile typescript to js
* `npm run watch`   watch for changes and compile
* `npm run test`    perform the jest unit tests
* `npx cdk deploy`  deploy this stack to your default AWS account/region
* `npx cdk diff`    compare deployed stack with current state
* `npx cdk synth`   emits the synthesized CloudFormation template



----

# Node.js 20+ 및 npm 설치
# ※ Node 20 이상이 필수다. aws-cdk-lib 2.264.0 / aws-cdk CLI 2.1135.1은 Node 20+를 요구하고,
#   Node 16/18에서는 CLI 번들 WASM(cdk-from-cfn)이 `externref`를 못 써서
#   `npx cdk`가 다음 에러로 즉시 죽는다: `CompileError: WebAssembly.Module(): invalid value type 'externref'`
```
# Amazon Linux 2023
sudo dnf install -y nodejs20 npm   # 또는 nodesource: curl -sL https://rpm.nodesource.com/setup_20.x | sudo bash - && sudo dnf install -y nodejs

# Amazon Linux 2 (구형 부트스트랩 EC2)
curl -sL https://rpm.nodesource.com/setup_20.x | sudo bash -
sudo yum install -y nodejs

node -v  # v20 이상인지 확인 (필수)
npm -v   # npm 버전 확인

sudo npm install -g aws-cdk

```

## CDK 프로젝트 생성

```
mkdir core-bank-cdk && cd core-bank-cdk
# CDK 초기화 (TypeScript 기반)
cdk init app --language typescript

```

### git clone
```
git clone https://github.com/AWS-KOREA-COMPOSABLE-ARCH/core-bank-cdk.git
cd core-bank-cdk
npm install

```


### Deploy

```
cdk bootstrap
cdk synth

cdk deploy
```

이 스택은 이름이 고정된 리소스(IAM 롤 `eksClusterNodeGroupRole`·`modernbank-service-role`, RDS 클러스터 5개,
MSK 컨피그 `composable-bank-kafka-config`, ECR 리포 7개, EKS OIDC provider)를 만든다.
이전 배포가 롤백된 상태라면 잔여 리소스를 먼저 지워야 `AlreadyExists`로 실패하지 않는다.

## 부트스트랩 EC2 (`cdk-deploy`)와 Node 버전

워크숍 흐름은 3단계다: 별도 CloudFormation 템플릿 `cdk-deploy`가 **배포용 EC2 한 대**를 띄우고,
그 EC2의 UserData가 이 리포를 클론해 `cdk bootstrap`(→ `CDKToolkit` 스택)과 `cdk deploy`(→ `CoreBankInfraStack`)를 실행한다.
CoreBankInfraStack의 출력(`IdeUrl`/`IdePassword`)이 code-server 접속 정보다.

**증상**: `cdk-deploy`만 `CREATE_COMPLETE`로 뜨고 `CDKToolkit`·`CoreBankInfraStack`이 아예 생기지 않는다.
(`cdk-deploy`의 `CREATE_COMPLETE`는 EC2가 떴다는 뜻일 뿐, 내부 `cdk deploy` 성공을 보장하지 않는다.)

**원인**: 부트스트랩 EC2의 UserData가 **Node 16**(`rpm.nodesource.com/setup_16.x`)을 설치했다.
`aws-cdk` CLI가 번들한 WASM 모듈(`cdk-from-cfn`)이 `externref`를 쓰는데 Node 16에는 없어서,
`cdk bootstrap`/`synth`/`deploy`가 로드 즉시 죽는다:
`CompileError: WebAssembly.Module(): invalid value type 'externref'`.
확인 위치는 EC2의 `/var/log/user-data.log`.

**근본 수정(단일 경로)**: 부트스트랩 EC2의 UserData는 이 리포를 클론한 뒤
**`bash scripts/deploy.sh` 하나만** 호출한다. 이 스크립트가
Node 설치 → `npm i` → `cdk bootstrap` → `cdk deploy` 를 전부 처리한다.
- Node 설치 지점이 이 스크립트 **한 곳뿐**이라 중복 설치가 없다(효율적, 에러 여지 최소화).
- UserData 는 더 이상 node 를 직접 깔지 않는다(예전 `setup_16.x` 제거).
- 수동으로 할 때도 `npm install`/`npx cdk` 를 직접 치지 말고 `bash scripts/deploy.sh`(= `npm run deploy`) 를 쓴다.

Node 20 으로 고친 참조용 부트스트랩 템플릿을 `bootstrap/cdk-deploy.yaml`에,
워크샵 원본 템플릿 수정본을 `composable-architecture-for-fsi-core-system/static/cdk_deploy.yaml`에 반영했다
(둘 다 `bash scripts/deploy.sh` 를 호출한다).

**주의(Amazon Linux 2 + glibc)**: 부트스트랩 EC2가 Amazon Linux 2(glibc 2.26)이면,
표준 Node 18/20 바이너리(nodesource RPM·nvm)는 glibc 2.28+ 를 요구해 설치돼도
`node: /lib64/libc.so.6: version 'GLIBC_2.28' not found` 로 실행조차 안 된다.
그래서 `scripts/deploy.sh` 는 glibc 를 감지해 2.28 미만이면
**glibc-217 비공식 빌드**(`unofficial-builds.nodejs.org`)를 `/usr/local` 에 설치한다.
Amazon Linux 2023(glibc 2.34)에서는 nodesource 표준 패키지를 쓴다.

**이미 뜬 EC2를 살려서 즉시 복구**(재시작 없이) — 리포의 스크립트가 위 분기를 다 처리한다:
```
cd core-bank-cdk             # UserData가 클론한 디렉터리
bash scripts/deploy.sh       # Node 20 설치(OS별 분기) + npm i + cdk bootstrap + cdk deploy
```
Amazon Linux 2에서 수동으로 하려면 glibc-217 빌드를 직접 받으면 된다:
```
curl -fsSL -o /tmp/node20.tar.gz \
  https://unofficial-builds.nodejs.org/download/release/v20.20.2/node-v20.20.2-linux-x64-glibc-217.tar.gz
sudo tar -xzf /tmp/node20.tar.gz -C /usr/local --strip-components=1
export PATH="/usr/local/bin:$PATH"; hash -r; node -v   # v20.x
```
이전 배포가 `ROLLBACK_FAILED`/`ROLLBACK_COMPLETE`로 남아 있으면 먼저 그 스택과
이름 고정 잔여 리소스를 지워야 `AlreadyExists`로 다시 막히지 않는다.

## 버전 고정 (2026-08 기준)

아래 버전은 임의로 올리거나 내리면 배포가 실패하거나 애플리케이션이 깨진다.
상세 근거는 `bin/core-bank-cdk.ts`의 주석에 있고, `test/app-contract.test.ts`가 이를 검증한다.

| 대상 | 버전 | 고정 이유 |
| --- | --- | --- |
| `aws-cdk-lib` | 2.264.0 | 2.215.0 미만은 EKS kubectl 프로바이더 Lambda가 `python3.11`이다. Lambda가 2026-07-31부터 이 런타임의 함수 생성을 차단하므로 배포가 실패한다 |
| EKS / kubectl 레이어 | 1.34 / `lambda-layer-kubectl-v34` | 1.32는 2026-03-23 표준 지원 종료(확장 지원 과금). 레이어는 클러스터 버전과 맞춰야 한다 |
| MSK Kafka | `3.9.x` | 3.6.0은 2026-06-01 지원 종료. 3.9.x는 ZooKeeper/KRaft를 모두 지원하는 마지막 버전 |
| Aurora PostgreSQL | 14.22 | 14.13은 2026-05-31 지원 종료. **메이저 17 이상 금지** — `rds.force_ssl` 기본값이 1(on)이 되어 `sslmode=disable`로 접속하는 `modernbank_user`(Go)가 죽는다. `db.r7g`는 14.7 이상을 요구하므로 14.6(LTS)도 쓸 수 없다 |
| ALB Controller | v2.17.1 | 2.8.2는 2024-08 버전. 이미지 리포지토리는 CDK 기본값(us-west-2)이 아니라 배포 리전으로 지정한다 |
| code-server | 4.129.0 | construct 기본값 4.91.1(VS Code 1.91.1)에서는 확장 3개가 엔진 요구를 넘어 2년 전 버전으로 폴백된다. 4.129.0(VS Code 1.129.0)이면 11개 확장 모두 최신본이 설치된다 |

## modernbank-demo 앱과의 계약

[modernbank-demo](https://github.com/AWS-KOREA-COMPOSABLE-ARCH/modernbank-demo)를 **수정 없이** 올리기 위한 제약이다.
바꾸려면 앱 소스/매니페스트/스크립트를 함께 고쳐야 한다.

- Aurora PostgreSQL 메이저는 16 이하 (`sslmode=disable`)
- MSK는 `unauthenticated` + `PLAINTEXT` 유지 (앱에 `security.protocol`/SASL 설정이 없고 `05-deploy-prep.sh`가 `BootstrapBrokerString`을 조회한다)
- MSK 컨피그의 `auto.create.topics.enable=true` 유지 (앱에 `NewTopic`/`KafkaAdmin` 빈이 없다)
- MSK 브로커 수는 클라이언트 서브넷 수의 배수
- ECR 리포지토리 7개 이름 유지: `modernbank-{account,b2bt,cqrs,customer,product,transfer,user}`
- IRSA 롤 이름 `modernbank-service-role`, 신뢰 조건 `system:serviceaccount:modernbank:modernbank-*-sa`
- 노드는 x86 (컨테이너 이미지가 x86 전용이라 Graviton으로 바꾸면 기동하지 않는다)
- writer 인스턴스의 `promotionTier`는 0 (`05-deploy-prep.sh`가 이 값으로 writer 엔드포인트를 찾는다)
- 서브넷 Name 태그 `CoreBankInfraStack/CoreBankVPC/core-bank-web-publicSubnet*` (`07-frontend.sh`가 이 태그로 검색한다)

```
npm test    # 위 계약을 검증한다
```

## vendor/

`@workshop-cdk-constructs/vscode-ide`(및 의존성 `ide-vpc`)는 공개 npm 레지스트리에 없어서
`vendor/`에 tgz로 포함하고 `package.json`에서 `file:`로 참조한다(Apache-2.0).
사설 레지스트리 접근이 가능하면 이 부분을 일반 의존성으로 되돌려도 된다.

### [참조] DB Credential - username password로 처리
- AWS Secret Manger를 이용해서 하나의 Secret으로 5개의 DB의 Credential을 공유하려고 했으나 CDK 내부적으로 fromSecret()를 호출할 때, RDS 클러스터에 연결하기 위해 SecretTargetAttachment를 자동 생성한다. 그런데 하나의 Secret은 단 하나의 RDS 클러스터에만 attach될 수 있기 때문에 동일한 Secret을 여러 RDS 클러스터의 Credential로 지정하면 CDK가 충돌을 일으킨다.
- [참조] CDK 내부 작동 원리 요약
- rds.DatabaseCluster는 rds.Credentials.fromSecret(...)을 받을 경우 Secret.attach(...)를 자동 호출합니다.
- 한 Secret은 하나의 SecretTargetAttachment만 생성할 수 있습니다. CDK는 중복 Attach에 대해 명시적 예외를 던집니다
- CloudFormation 레벨에서는 여러 DB에 같은 Secret을 수동으로 설정할 수 있지만, CDK는 추상화의 일관성을 유지하려고 막고 있습니다.
