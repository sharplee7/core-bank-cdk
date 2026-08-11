import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { CoreBankInfraStack } from '../bin/core-bank-cdk';

/**
 * modernbank-demo 애플리케이션을 "무수정"으로 올릴 수 있는 인프라 계약을 고정하는 테스트.
 * 여기서 실패하면 앱(소스/매니페스트/스크립트) 수정 없이는 동작하지 않는 상태다.
 */
describe('modernbank 앱 무수정 배포 계약', () => {
    let template: Template;

    beforeAll(() => {
        const app = new cdk.App();
        const stack = new CoreBankInfraStack(app, 'ContractTestStack');
        template = Template.fromStack(stack);
    });

    // Lambda가 생성 차단된 런타임을 쓰면 CloudFormation이 스택 생성 자체를 실패시킨다.
    // (aws-cdk-lib 2.181.1의 EKS kubectl 핸들러가 python3.11이라 2026-07-31부터 배포 불가였다)
    test('생성이 차단된 Lambda 런타임을 사용하지 않는다', () => {
        const blocked = ['python3.9', 'python3.10', 'python3.11', 'nodejs16.x', 'nodejs18.x'];
        const fns = template.findResources('AWS::Lambda::Function');
        const violations = Object.entries(fns)
            .map(([id, r]) => [id, (r.Properties as any)?.Runtime as string] as const)
            .filter(([, rt]) => blocked.includes(rt));
        expect(violations).toEqual([]);
    });

    // modernbank_user(Go)는 sslmode=disable 로 접속한다.
    // Aurora PostgreSQL 17 이상은 rds.force_ssl 기본값이 1(on)이라 접속이 거부된다.
    test('Aurora PostgreSQL 메이저 버전이 16 이하다 (rds.force_ssl 기본 off)', () => {
        const clusters = template.findResources('AWS::RDS::DBCluster');
        expect(Object.keys(clusters)).toHaveLength(5);
        for (const [id, r] of Object.entries(clusters)) {
            const version = (r.Properties as any).EngineVersion as string;
            const major = parseInt(version.split('.')[0], 10);
            expect(major).toBeLessThanOrEqual(16);
            // db.r7g는 Aurora PostgreSQL 14.7 이상만 지원한다
            if (major === 14) {
                expect(parseInt(version.split('.')[1], 10)).toBeGreaterThanOrEqual(7);
            }
            expect(id).toBeTruthy();
        }
    });

    // 앱은 9092 PLAINTEXT로만 접속하고, 토픽을 만들지 않는다(NewTopic/KafkaAdmin 빈 없음).
    test('MSK는 PLAINTEXT + 비인증 + 토픽 자동생성을 유지한다', () => {
        template.hasResourceProperties('AWS::MSK::Cluster', {
            ClientAuthentication: { Unauthenticated: { Enabled: true } },
            EncryptionInfo: { EncryptionInTransit: { ClientBroker: 'PLAINTEXT' } },
        });
        template.hasResourceProperties('AWS::MSK::Configuration', {
            ServerProperties: Match.stringLikeRegexp('auto\\.create\\.topics\\.enable=true'),
        });
    });

    // MSK는 지정한 서브넷에 브로커를 균등 분배하므로 배수가 아니면 생성이 실패한다.
    test('MSK 브로커 수가 클라이언트 서브넷 수의 배수다', () => {
        const cluster = Object.values(template.findResources('AWS::MSK::Cluster'))[0];
        const props = cluster.Properties as any;
        const subnets = props.BrokerNodeGroupInfo.ClientSubnets.length;
        expect(props.NumberOfBrokerNodes % subnets).toBe(0);
    });

    // containerize.sh 가 이 이름으로 push 하고 k8s deployment 가 이 이름으로 pull 한다.
    test('ECR 리포지토리 이름이 앱 빌드 스크립트와 일치한다', () => {
        const repos = Object.values(template.findResources('AWS::ECR::Repository'))
            .map((r) => (r.Properties as any).RepositoryName as string)
            .sort();
        expect(repos).toEqual([
            'modernbank-account',
            'modernbank-b2bt',
            'modernbank-cqrs',
            'modernbank-customer',
            'modernbank-product',
            'modernbank-transfer',
            'modernbank-user',
        ]);
    });

    // clusterOpenIdConnectIssuerUrl.substring(8)로 토큰을 자르면 신뢰 정책이 훼손되어
    // IAM CreateRole이 MalformedPolicyDocument로 실패한다.
    test('IRSA 롤의 신뢰 정책에 훼손된 토큰 문자열이 없다', () => {
        const roles = template.findResources('AWS::IAM::Role');
        const podRole = Object.entries(roles).find(
            ([, r]) => (r.Properties as any).RoleName === 'modernbank-service-role',
        );
        expect(podRole).toBeDefined();
        const principal = (podRole![1].Properties as any).AssumeRolePolicyDocument.Statement[0].Principal;
        const doc = JSON.stringify((podRole![1].Properties as any).AssumeRolePolicyDocument);
        expect(doc).not.toMatch(/TOKEN\./);
        // Principal은 문자열로 조립한 ARN이 아니라 OIDC provider 리소스 참조여야 한다
        expect(principal.Federated).toHaveProperty('Ref');
    });

    // EKS 노드는 x86 이미지(eclipse-temurin/alpine)를 실행하므로 arm64로 바꾸면 안 된다.
    test('노드그룹 AMI 타입이 x86_64다', () => {
        template.hasResourceProperties('AWS::EKS::Nodegroup', {
            AmiType: Match.stringLikeRegexp('x86_64'),
        });
    });
});
