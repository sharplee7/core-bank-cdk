
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

# Node.js 및 npm 설치 (Amazon Linux 2023의 기본 패키지 사용)
```
sudo dnf install -y nodejs npm

node -v  # Node.js 버전 확인
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
