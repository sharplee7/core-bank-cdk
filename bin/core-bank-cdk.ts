import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from "aws-cdk-lib/aws-iam";
import * as eks from 'aws-cdk-lib/aws-eks';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as msk from 'aws-cdk-lib/aws-msk';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cr from 'aws-cdk-lib/custom-resources'
import { KubectlV34Layer as KubectlLayer } from "@aws-cdk/lambda-layer-kubectl-v34"
import { VSCodeIde } from "@workshop-cdk-constructs/vscode-ide"
import { Identity } from 'aws-cdk-lib/aws-ses';
//import * as serverlessrepo from 'aws-cdk-lib/aws-serverlessrepo';
//import * as kubectl from '@aws-cdk/lambda-layer-kubectl';

export class CoreBankInfraStack extends cdk.Stack {
    public readonly vpc: ec2.Vpc;
    public readonly kafkaCluster: msk.CfnCluster;
    public readonly eksCluster: eks.Cluster;
    public readonly secret: secretsmanager.Secret;
    public readonly ec2Instance: ec2.Instance;
    public readonly rdsClusters: rds.DatabaseCluster[] = [];
    public readonly vscodeIde: VSCodeIde;

    constructor(scope: Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);

        const region = cdk.Stack.of(this).region;
        const account = cdk.Stack.of(this).account;

        // VPC
        this.vpc = new ec2.Vpc(this, 'CoreBankVPC', {
            ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/16'),
            maxAzs: 3,
            subnetConfiguration: [
                { name: 'core-bank-web-public', subnetType: ec2.SubnetType.PUBLIC },
                { name: 'core-bank-eks-msk-private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
                { name: 'core-bank-DB-private', subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
            ],
        });

        // VPC Endpoints
        this.vpc.addGatewayEndpoint('S3Endpoint', { service: ec2.GatewayVpcEndpointAwsService.S3 });
        this.vpc.addGatewayEndpoint('DynamoDBEndpoint', { service: ec2.GatewayVpcEndpointAwsService.DYNAMODB });

        // MSK 보안 그룹 생성
        const mskSecurityGroup = new ec2.SecurityGroup(this, 'MskSecurityGroup', {
            vpc: this.vpc,
            allowAllOutbound: true,
            description: 'Security group for MSK cluster'
        });

        // MSK Cluster
        this.kafkaCluster = new msk.CfnCluster(this, 'KafkaCluster', {
            clusterName: 'composable-bank-kafka-cluster',
            // Kafka 3.6.0은 2026-06-01 지원 종료(신규 생성 불가). 3.9.x는 ZooKeeper/KRaft를
            // 모두 지원하는 마지막 버전이며 릴리스 후 최소 2년간 확장 지원된다.
            // 인증(unauthenticated)/암호화(PLAINTEXT)/serverProperties는 modernbank 앱이
            // 9092 PLAINTEXT + 토픽 자동생성에 의존하므로 절대 변경하지 말 것.
            kafkaVersion: '3.9.x',
            numberOfBrokerNodes: 4,
            brokerNodeGroupInfo: {
                instanceType: 'kafka.m5.large',
                clientSubnets: this.vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }).subnetIds,
                storageInfo: { ebsStorageInfo: { volumeSize: 1000 } },
                securityGroups: [mskSecurityGroup.securityGroupId],
            },
            configurationInfo: {
                arn: new msk.CfnConfiguration(this, 'KafkaConfiguration', {
                    name: 'composable-bank-kafka-config',
                    kafkaVersionsList: ['3.9.x'],
                    serverProperties: 
                        'auto.create.topics.enable=true\n' +
                        'delete.topic.enable=true\n'
                }).attrArn,
                revision: 1
            },
            clientAuthentication: {
                unauthenticated: {
                    enabled: true
                }
            },
            encryptionInfo: {
                encryptionInTransit: {
                    clientBroker: 'PLAINTEXT',
                    inCluster: true
                }
            }
        });


        // EKS 클러스터 생성
        const clusterLogging = [
            // eks.ClusterLoggingTypes.API,
            // eks.ClusterLoggingTypes.AUTHENTICATOR,
            // eks.ClusterLoggingTypes.SCHEDULER,
            eks.ClusterLoggingTypes.AUDIT,
            // eks.ClusterLoggingTypes.CONTROLLER_MANAGER,
          ];

        this.eksCluster = new eks.Cluster(this, 'CoreBankEKSCluster', {
            vpc: this.vpc,
            defaultCapacity: 0, // 기본 용량을 0으로 설정하여 관리형 노드 그룹을 수동으로 추가
            // 1.32는 2026-03-23에 표준 지원이 종료되어 확장 지원(시간당 추가 과금) 구간이다.
            // kubectlLayer는 클러스터 버전과 맞춰야 한다(v34 <-> V1_34).
            version: eks.KubernetesVersion.V1_34,
            kubectlLayer: new KubectlLayer(this, "kubectl"),
            ipFamily: eks.IpFamily.IP_V4,
            clusterLogging: clusterLogging,
            vpcSubnets: [
                {
                    subnetGroupName: 'core-bank-eks-msk-private',
                }
            ],
            authenticationMode: cdk.aws_eks.AuthenticationMode.API_AND_CONFIG_MAP,
        });
    
        this.eksCluster.addNodegroupCapacity("custom-node-group", {
            amiType: eks.NodegroupAmiType.AL2023_X86_64_STANDARD,
            // modernbank 서비스 6개(512Mi/250m) + kube-system + ALB 컨트롤러를 t3.medium 2대에
            // 올리면 여유가 거의 없다. t3.large로 상향(컨테이너 이미지가 x86이므로 Graviton 금지).
            instanceTypes: [new ec2.InstanceType('t3.large')],
            desiredSize: 2,
            minSize: 2,
            maxSize: 5,
            diskSize: 20,
            nodeRole: new iam.Role(this, "eksClusterNodeGroupRole", {
              roleName: "eksClusterNodeGroupRole",
              assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
              managedPolicies: [
                "AmazonEKSWorkerNodePolicy",
                "AmazonEC2ContainerRegistryReadOnly",
                "AmazonEKS_CNI_Policy",
                "AmazonDynamoDBFullAccess",
              ].map((policy) => iam.ManagedPolicy.fromAwsManagedPolicyName(policy)),
            }),
          }
        );

        // Create RDS Security Group
        const rdsSecurityGroup = new ec2.SecurityGroup(this, 'RdsSecurityGroup', {
            vpc: this.vpc,
            allowAllOutbound: true,
        });

        // Allow EKS Pods to access RDS
        rdsSecurityGroup.addIngressRule(this.eksCluster.clusterSecurityGroup, ec2.Port.tcp(5432), 'Allow EKS to access RDS');


        // Aurora RDS Instances (5 DBs)
        const dbNames = ['modernbank-account', 'modernbank-user', 'modernbank-transfer', 'modernbank-customer', 'modernbank-cqrs'];
        
        dbNames.forEach((dbName, index) => {
  
            const dbCluster = new rds.DatabaseCluster(this, `${dbName}`, { // 고유한 ID 사용
                // 14.13은 2026-05-31에 Aurora 표준 지원이 종료되어 신규 생성이 불가하다.
                // 메이저 14를 유지하는 이유:
                //  - Aurora PG 17 이상은 rds.force_ssl 기본값이 1(on)이라
                //    modernbank_user(Go, sslmode=disable)가 접속 실패한다.
                //  - db.r7g.large는 Aurora PG 14.7 이상을 요구하므로 14.6(LTS)은 쓸 수 없다.
                // => 14 계열 최신인 14.22 사용 (PG14 메이저 표준 지원은 2027-02-28까지)
                engine: rds.DatabaseClusterEngine.auroraPostgres({ version: rds.AuroraPostgresEngineVersion.VER_14_22 }),
        
                // 클러스터에 username, password 사용
                //credentials: rds.Credentials.fromSecret(this.secret),
                credentials: rds.Credentials.fromUsername('postgres', {
                    // password: cdk.SecretValue.unsafePlainText('postgres1234!'),
                    password: cdk.SecretValue.unsafePlainText('admin1234'),
                }),
        
                vpc: this.vpc, 
                vpcSubnets: { 
                    subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
                },
        
                writer: rds.ClusterInstance.provisioned(`writer-${dbName}`, {
                    instanceType: ec2.InstanceType.of(ec2.InstanceClass.R7G, ec2.InstanceSize.LARGE),
                    // securityGroups: [rdsSecurityGroup], // ✅ 서브넷 설정은 제거 (지원되지 않음)
                }),
                readers: [
                    rds.ClusterInstance.provisioned(`reader-${dbName}`, {
                        instanceType: ec2.InstanceType.of(ec2.InstanceClass.R7G, ec2.InstanceSize.LARGE),
                        // securityGroups: [rdsSecurityGroup], // ✅ 서브넷 설정은 제거 (지원되지 않음)
                    }),
                ],
                clusterIdentifier: dbName,
            });
        
            this.rdsClusters.push(dbCluster);
        });



        // // DynamoDB Tables
        // new dynamodb.Table(this, 'CustomerTable', {
        //     tableName: 'customer',
        //     partitionKey: { name: 'customerId', type: dynamodb.AttributeType.STRING },
        // });

        // new dynamodb.Table(this, 'GenAITable', {
        //     tableName: 'genAIManagement',
        //     partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
        // });

        // new dynamodb.Table(this, 'ProductTable', {
        //     tableName: 'product',
        //     partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
        // });

        // EKS cluster 생성 코드 다음에 추가

        // OIDC Provider를 위한 OpenID Connect Provider URL 가져오기, IRSA위한 구현
        // EKS 인증을 API 및 ConfigMap으로 설정했으므로 아래와 같이 생성을 걸면 충돌이 난다. 
        //Received response status [FAILED] from custom resource. Message returned: EntityAlreadyExistsException: Provider with url https://oidc.eks.a
        //p-northeast-2.amazonaws.com/id/BF0AE4A064249CB6A30CBEF3ED1B6921 already exists.
        //따라서 fromOpenIdConnectProviderArn을 사용하여 생성한다.
        // const openIdConnectProvider = new iam.OpenIdConnectProvider(this, 'CoreBankEksOIDCProvider', {
        //     url: this.eksCluster.clusterOpenIdConnectIssuerUrl,
        //     clientIds: ['sts.amazonaws.com'],
        // });
        
        // EKS 클러스터가 관리하는 OIDC provider를 그대로 사용한다.
        // (ALB 컨트롤러도 같은 provider를 쓰므로 중복 생성/EntityAlreadyExists가 발생하지 않는다)
        const openIdConnectProvider = this.eksCluster.openIdConnectProvider;
        const oidcIssuer = openIdConnectProvider.openIdConnectProviderIssuer;

        // [수정 이력] 기존에는 clusterOpenIdConnectIssuerUrl.substring(8)로 issuer를 잘라 썼는데,
        // 이 값은 배포 시점에 결정되는 CDK 토큰("${Token[TOKEN.1234]}")이라 문자열을 자르면
        // "TOKEN.1234]}" 로 훼손된다. 그 결과 신뢰 정책의 Principal ARN과 조건 키가 모두 깨져
        // IAM CreateRole이 MalformedPolicyDocument로 실패했다.
        // 조건 키(key)에 토큰이 들어가야 하므로 CfnJson으로 감싼다(CDK ServiceAccount와 동일 패턴).
        const podRoleConditions = new cdk.CfnJson(this, 'CoreBankPodRoleConditionJson', {
            value: {
                [`${oidcIssuer}:aud`]: 'sts.amazonaws.com',
                [`${oidcIssuer}:sub`]: 'system:serviceaccount:modernbank:modernbank-*-sa',
            },
        });

        // Pod용 IAM Role 생성 (IRSA)
        const podRole = new iam.Role(this, 'CoreBankPodRole', {
            roleName: 'modernbank-service-role',
            assumedBy: new iam.OpenIdConnectPrincipal(openIdConnectProvider).withConditions({
                StringLike: podRoleConditions,
            }),
        });
        
        // MSK 권한 정책
        const mskPolicy = new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['kafka:*'],
            resources: [`${this.kafkaCluster.attrArn}/*`],
        });
        
        // RDS 권한 정책
        const rdsPolicy = new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['rds:*'],
            resources: this.rdsClusters.map(cluster => 
            `arn:aws:rds:${region}:${account}:db:${cluster.clusterIdentifier}`
            ),
        });
        
        // DynamoDB 권한 정책
        const dynamodbPolicy = new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['dynamodb:*'],
            resources: [
            `arn:aws:dynamodb:${region}:${account}:table/product`,
            `arn:aws:dynamodb:${region}:${account}:table/customer`
            ],
        });
        
        // 정책들을 Role에 추가
        podRole.addToPolicy(mskPolicy);
        podRole.addToPolicy(rdsPolicy);
        podRole.addToPolicy(dynamodbPolicy);
        

        // OIDC Provider URL 검증을 위한 출력
        new cdk.CfnOutput(this, 'OIDCProviderUrl', {
            value: this.eksCluster.clusterOpenIdConnectIssuerUrl,
            description: 'OIDC Provider URL'
        });

        // OIDC Provider ARN 검증을 위한 출력
        new cdk.CfnOutput(this, 'OIDCProviderArn', {
            value: openIdConnectProvider.openIdConnectProviderArn,
            description: 'OIDC Provider ARN'
        });


        // Role ARN을 출력값으로 추가 (선택사항)
        new cdk.CfnOutput(this, 'PodRoleArn', {
            value: podRole.roleArn,
            description: 'ARN of IAM Role for EKS Pods'
        });


        // Public AMI를 사용하는 EC2 인스턴스 추가
        const publicSubnet = this.vpc.selectSubnets({ subnetType: ec2.SubnetType.PUBLIC }).subnets[0];

        // 보안 그룹 생성
        const securityGroup = new ec2.SecurityGroup(this, 'CoreBankEc2SecurityGroup', {
            vpc: this.vpc,
            allowAllOutbound: true, // 모든 아웃바운드 트래픽 허용
        });

        // SSH (22번 포트) 허용
        securityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(22), 'Allow SSH access from anywhere');
        // SSH (8080번 포트) 허용 - VS Code (기존에는 실수로 22번을 중복 등록하고 있었다)
        securityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(8080), 'Allow 8080 access from anywhere');

        // RDS 접근 허용
        this.rdsClusters.forEach(cluster => {
            cluster.connections.allowDefaultPortFrom(securityGroup, 'Allow EC2 to connect to RDS');
        });

        // EC2 인스턴스를 위한 Role 생성
        const ec2Role = new iam.Role(this, 'CoreBankEc2Role', {
            assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
            // AdministratorAccess 관리형 정책 추가
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('AdministratorAccess')
            ]
        });

        /////////////////////////////////
        // 추가 개발영역
        /////////////////////////////////

        //ALB 컨트롤러 설치. VPC태그 및 서브넷 태그 자동 추가.
        const albController = new eks.AlbController(this, 'CoreBankEKSAlbController', {
            cluster: this.eksCluster,
            // 2.8.2(2024-08)는 너무 오래됐다. modernbank의 Ingress 어노테이션은
            // 2.17.x에서 모두 유효하며, aws-cdk-lib 2.264.0에 v2.17.1용 IAM 정책이 번들되어 있다.
            version: eks.AlbControllerVersion.V2_17_1,
            // CDK 기본값이 us-west-2 레지스트리로 고정되어 있어 배포 리전으로 교정
            repository: `602401143452.dkr.ecr.${region}.amazonaws.com/amazon/aws-load-balancer-controller`,
          });

        // ECR 처리
        // CoreBankInfraStack 클래스 내부에 추가
        const repositoryNames = [
            'modernbank-account',
            'modernbank-b2bt',
            'modernbank-customer',
            'modernbank-cqrs',
            'modernbank-transfer',
            'modernbank-product',
            'modernbank-user'
        ];

        // ECR 리포지토리 생성
        const ecrRepositories = repositoryNames.map(repoName => 
            new ecr.Repository(this, `${repoName}Repository`, {
                repositoryName: repoName,
                // 선택적 설정
                removalPolicy: cdk.RemovalPolicy.DESTROY, // 스택 삭제 시 리포지토리도 삭제
                emptyOnDelete: true, // 이미지가 남아 있어도 삭제 가능(없으면 스택 삭제가 실패한다)
                imageScanOnPush: true, // 이미지 푸시 시 취약점 스캔
                lifecycleRules: [
                    {
                        maxImageCount: 5, // 최대 이미지 수 제한
                        description: 'Keep only last 5 images'
                    }
                ]
            })
        );

        // (선택사항) 리포지토리 ARN을 출력값으로 추가
        repositoryNames.forEach((repoName, index) => {
            new cdk.CfnOutput(this, `${repoName}RepositoryArn`, {
                value: ecrRepositories[index].repositoryArn,
                description: `ARN of ${repoName} ECR Repository`
            });
            new cdk.CfnOutput(this, `${repoName}RepositoryUri`, {
                value: ecrRepositories[index].repositoryUri,
                description: `URI of ${repoName} ECR Repository`
            });
        });

        //vscode 인스턴스 개발중

        const ideRole = new iam.Role(this, 'CoreBankIdeRole', {
            assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('AdministratorAccess')
            ]
        });

        ideRole.addToPolicy(
            new iam.PolicyStatement({
                actions: ["ec2:*"],
                resources: ["*"],
            })
        )

        //vscode에 매핑되는 role이 eks의 access entry로 적용될 수 있도록 해야 
        //kubectl 이 승인됨
        const eksAccessEntry = new eks.AccessEntry(this, 'IdeEksAccessEntry', {
            cluster: this.eksCluster,
            principal: ideRole.roleArn,
            accessEntryType: eks.AccessEntryType.STANDARD,
            accessPolicies: [
                eks.AccessPolicy.fromAccessPolicyName(
                    'AmazonEKSClusterAdminPolicy',
                     {
                        accessScopeType: eks.AccessScopeType.CLUSTER,
                    }
                ),
            ]    
        });

        new cdk.CfnOutput(this, 'IdeEksAccessEntryArn', {
            value: eksAccessEntry.accessEntryArn,
            description: 'ARN of EKS Access Entry'
        });

        this.vscodeIde = new VSCodeIde(this, "CoreBankVSCodeIde", {
            vpc: this.vpc,
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.XLARGE),
            // construct 기본값은 4.91.1(VS Code 1.91.1, 2024-07)이다. 그 버전에서는
            // 아래 extensions 중 3개(kubernetes-tools ^1.110, java-dependency ^1.95,
            // vmware.vscode-spring-boot ^1.92)가 엔진 요구를 넘어서 2년 전 구버전으로
            // 폴백 설치되고, redhat.java(최신)와 vscjava 계열의 버전 짝이 어긋난다.
            // 4.129.0 = VS Code 1.129.0 이라 11개 확장 모두 최신본으로 설치된다.
            codeServerVersion: '4.129.0',
            bootstrapTimeoutMinutes: 30,
            bootstrapScript: `
                curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"
                chmod +x kubectl
                sudo mv kubectl /usr/local/bin
            `,
            // bootstrapScript: `
            //     curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"
            //     chmod +x kubectl
            //     sudo mv kubectl /usr/local/bin

            //     sudo -u ec2-user bash -c "aws eks update-kubeconfig --name $(aws eks list-clusters --output json | jq -r '.clusters[0]')"
            //     sudo -u ec2-user bash -c "kubectl create namespace modernbank"
            //     sudo -u ec2-user bash -c "git clone https://github.com/sharplee7/modernbank-demo --branch V2.0-Add-Compensation --single-branch"
            //     sudo -u ec2-user bash -c "cd modernbank-demo; kubectl apply -f k8s/ingress.yaml"
            // `,
            extensions: [
                "AmazonWebServices.aws-toolkit-vscode",
                "ms-kubernetes-tools.vscode-kubernetes-tools",
                "redhat.vscode-yaml",
                "vscjava.vscode-spring-initializr",
                "vscjava.vscode-spring-boot-dashboard",
                "vscjava.vscode-java-dependency",
                "vscjava.vscode-gradle",
                "vmware.vscode-spring-boot",
                "vmware.vscode-boot-dev-pack",
                "redhat.java",
                "golang.go",
            ],
            role: ideRole,
            exportIdePassword: false,
        })

        // VSCode IDE에 의존성 추가
        // this.vscodeIde.node.addDependency(this.eksCluster);
        this.vscodeIde.node.addDependency(albController);

        const ideUrlOutput = new cdk.CfnOutput(this, "IdeUrl", { value: this.vscodeIde.accessUrl})
        const idePasswordOutput = new cdk.CfnOutput(this, "IdePassword", { value: this.vscodeIde.getIdePassword()})

        const vscodeSecurityGroup = this.vscodeIde.ec2Instance.connections.securityGroups[0];

        // EKS 클러스터의 보안 그룹에 인바운드 규칙 추가해야 kubectl 에 eks api를 호출할 수 있음.
        this.eksCluster.clusterSecurityGroup.addIngressRule(
            vscodeSecurityGroup,
            ec2.Port.allTraffic(),
            'Allow all traffic from VSCode IDE security group'
        );

        // VSCode, EKS에서 RDS 접근 허용
        this.rdsClusters.forEach(cluster => {
            cluster.connections.allowDefaultPortFrom(vscodeSecurityGroup, 'Allow VSCode EC2 to connect to RDS');
            cluster.connections.allowDefaultPortFrom(this.eksCluster.clusterSecurityGroup, 'Allow EKS cluster to connect RDS')
        });

        // EKS 클러스터의 보안 그룹에서 MSK로의 접근 허용
        // Kafka 기본 포트: 9092(일반), 9094(TLS), 9096(IAM), 2181(ZooKeeper)
        mskSecurityGroup.addIngressRule(
            this.eksCluster.clusterSecurityGroup, 
            ec2.Port.tcp(9092), 
            'Allow EKS to access MSK (plaintext)'
        );

        mskSecurityGroup.addIngressRule(
            this.eksCluster.clusterSecurityGroup, 
            ec2.Port.tcp(9094), 
            'Allow EKS to access MSK (TLS)'
        );

        mskSecurityGroup.addIngressRule(
            this.eksCluster.clusterSecurityGroup, 
            ec2.Port.tcp(9096), 
            'Allow EKS to access MSK (IAM)'
        );

        mskSecurityGroup.addIngressRule(
            this.eksCluster.clusterSecurityGroup, 
            ec2.Port.tcp(2181), 
            'Allow EKS to access ZooKeeper'
        );

        // VSCode IDE에서도 MSK에 접근할 수 있도록 설정
        mskSecurityGroup.addIngressRule(
            vscodeSecurityGroup, 
            ec2.Port.tcp(9092), 
            'Allow VSCode IDE to access MSK (plaintext)'
        );
        
        mskSecurityGroup.addIngressRule(
            vscodeSecurityGroup, 
            ec2.Port.tcp(9094), 
            'Allow VSCode IDE to access MSK (TLS)'
        );
        
        mskSecurityGroup.addIngressRule(
            vscodeSecurityGroup, 
            ec2.Port.tcp(9096), 
            'Allow VSCode IDE to access MSK (IAM)'
        );
        
        mskSecurityGroup.addIngressRule(
            vscodeSecurityGroup, 
            ec2.Port.tcp(2181), 
            'Allow VSCode IDE to access ZooKeeper'
        );

        // (선택사항) 보안 그룹 ID를 출력값으로 추가 - 디버깅용
        new cdk.CfnOutput(this, 'VSCodeSecurityGroupId', {
            value: vscodeSecurityGroup.securityGroupId,
            description: 'Security Group ID of VSCode IDE'
        });

                
        // MSK 보안 그룹 ID 출력
        new cdk.CfnOutput(this, 'MSKSecurityGroupId', {
            value: mskSecurityGroup.securityGroupId,
            description: 'Security Group ID of MSK Cluster'
        });
        
        // EKS 보안 그룹 ID 출력
        new cdk.CfnOutput(this, 'EKSSecurityGroupId', {
            value: this.eksCluster.clusterSecurityGroup.securityGroupId,
            description: 'Security Group ID of EKS Cluster'
        });
        
    }
}

const app = new cdk.App();
new CoreBankInfraStack(app, 'CoreBankInfraStack',);
app.synth();
