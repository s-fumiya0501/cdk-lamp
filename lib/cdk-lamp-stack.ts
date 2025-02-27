import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';


export class CdkLampStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    // 1. VPC を作成  
    const vpc = ec2.Vpc.fromLookup(this, 'ExistingVPC', {
      vpcId: 'vpc-02b5eb5d25b928589', // 既存のVPCのIDを指定
    });
    const publicSubnets = vpc.publicSubnets;
    const privateSubnets = vpc.privateSubnets;

    const albSecurityGroup = new ec2.SecurityGroup(this, 'ALBSecurityGroup', {
      vpc,
      description: 'Allow HTTP from specific IP',
      allowAllOutbound: true,
    });
    albSecurityGroup.addIngressRule(ec2.Peer.ipv4('122.210.238.201/32'), ec2.Port.tcp(80), 'Allow HTTP from specific IP');
    albSecurityGroup.addIngressRule(ec2.Peer.ipv4('122.210.238.201/32'), ec2.Port.tcp(443), 'Allow HTTPS from specific IP'); 
    albSecurityGroup.addIngressRule(ec2.Peer.ipv4('113.37.225.8/32'), ec2.Port.tcp(80), 'Allow HTTP from specific IP');
    albSecurityGroup.addIngressRule(ec2.Peer.ipv4('113.37.225.8/32'), ec2.Port.tcp(443), 'Allow HTTPS from specific IP');
    
    const ecsSecurityGroup = new ec2.SecurityGroup(this, 'EcsInstanceSecurityGroup', {
      vpc,
      description: 'Allow inbound traffic from ALB',
      allowAllOutbound: true,
    });

    ecsSecurityGroup.addIngressRule(ec2.Peer.ipv4('10.0.0.0/20'), ec2.Port.tcp(8888), 'Allow TCP 8888 from 10.0.0.0/20');
    ecsSecurityGroup.addIngressRule(ec2.Peer.ipv4('10.0.0.0/20'), ec2.Port.tcp(80), 'Allow TCP 80 from 10.0.0.0/20');    
    ecsSecurityGroup.addIngressRule(ec2.Peer.ipv4('10.0.0.0/20'), ec2.Port.tcp(8080), 'Allow TCP 8080 from 10.0.0.0/20');

    ecsSecurityGroup.addIngressRule(ec2.Peer.ipv4('10.0.16.0/20'), ec2.Port.tcp(8888), 'Allow TCP 8888 from 10.0.0.0/20');
    ecsSecurityGroup.addIngressRule(ec2.Peer.ipv4('10.0.16.0/20'), ec2.Port.tcp(80), 'Allow TCP 80 from 10.0.0.0/20');    
    ecsSecurityGroup.addIngressRule(ec2.Peer.ipv4('10.0.16.0/20'), ec2.Port.tcp(8080), 'Allow TCP 8080 from 10.0.0.0/20');
    // 2. ECS クラスターを作成
    const cluster = new ecs.Cluster(this, 'LampCluster', {
      vpc,
    });

    // 3. ECS インスタンス用の IAM ロールを作成
    const existingIamRole = iam.Role.fromRoleArn(this, 'ExistingEcsRole', 
      'arn:aws:iam::735125878431:role/ecsInstanceRole', // 🔥 既存のロール ARN を指定
      { mutable: false }// 既存のロールを変更しな
    );
    // 4. ECS インスタンスを Auto Scaling で管理
    const asg = new autoscaling.AutoScalingGroup(this, 'EcsAutoScalingGroup', {
      vpc,
      vpcSubnets: { subnets: privateSubnets }, // Private Subnet に配置
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T2, ec2.InstanceSize.SMALL),
      machineImage: ecs.EcsOptimizedImage.amazonLinux2023(),
      minCapacity: 1,
      maxCapacity: 3,
      desiredCapacity: 1,
      role: existingIamRole,
      securityGroup: ecsSecurityGroup,
    });



    // 5. ECS クラスターに Capacity Provider を追加
    const capacityProvider = new ecs.AsgCapacityProvider(this, 'EcsCapacityProvider', {
      autoScalingGroup: asg,
    });

    // 6. クラスターに Capacity Provider を追加
    cluster.addAsgCapacityProvider(capacityProvider);

    // 7. Application Load Balancer を作成/設定
    const alb = new elbv2.ApplicationLoadBalancer(this, 'LampALB', {
      vpc,
      internetFacing: true,
      vpcSubnets: { subnets: publicSubnets },
      securityGroup: albSecurityGroup,
    });


    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'MyHostedZone', {
      hostedZoneId: 'Z0961844B43SYO7C4Q38', // Route 53 のホストゾーン ID
      zoneName: 'sano.ss-sre-admin.net', // ルートドメイン（最後の `.` は不要）
    });

    // ✅ ワイルドカード A レコード（`*.lamp.sanfdfso.ss-dfdsre-admdfin.net`）
    new route53.ARecord(this, 'WildcardALBARecord', {
      zone: hostedZone,
      recordName: '*.lamp.sano.ss-sre-admin.net', // ワイルドカード
      target: route53.RecordTarget.fromAlias(new route53Targets.LoadBalancerTarget(alb)),
    });



    const taskDefinition = new ecs.Ec2TaskDefinition(this, 'LampTaskDef');
    taskDefinition.addVolume({
      name: "html-data",
    });

    // ✅ 1. MySQL コンテナ（3306:3306）
    const mysqlContainer = taskDefinition.addContainer('mysql-container', {
      image: ecs.ContainerImage.fromRegistry('public.ecr.aws/docker/library/mysql:9.2.0'),
      memoryLimitMiB: 1024,
      cpu: 512,
      environment: {
        MYSQL_ROOT_PASSWORD: 'rootpassword',
        MYSQL_DATABASE: 'lampdb',
        MYSQL_USER: 'lampuser',
        MYSQL_PASSWORD: 'lamppassword',
      },
      logging: new ecs.AwsLogDriver({ streamPrefix: 'mysql' }),
    });
    mysqlContainer.addPortMappings({ 
      containerPort: 3306, // MySQL 内部ポート
      hostPort: 3306       // ECS EC2 の外部ポート
    });
    
    const phpMyAdminContainer = taskDefinition.addContainer('phpmyadmin-container', {
      image: ecs.ContainerImage.fromRegistry('public.ecr.aws/docker/library/phpmyadmin:latest'),
      memoryLimitMiB: 256,
      cpu: 128,
      environment: {
        PMA_HOST: 'mysql-container', // ← ここを修正
        PMA_PORT: '3306',
        MYSQL_ROOT_PASSWORD: 'rootpassword',
      },
      logging: new ecs.AwsLogDriver({ streamPrefix: 'phpmyadmin' }),
    });
    phpMyAdminContainer.addPortMappings({ 
      containerPort: 80,   // phpMyAdmin 内部ポート
      hostPort: 8888       // ECS EC2 の外部ポート
    });
    
    // ✅ 2. PHP-Apache コンテナ（80:8080）
    const phpContainer = taskDefinition.addContainer('php-apache-container', {
      image: ecs.ContainerImage.fromRegistry('public.ecr.aws/docker/library/php:8.2.27-apache'),
      memoryLimitMiB: 256,
      cpu: 384,
      environment: {
        DB_HOST: 'mysql-container', // MySQL へ接続
        DB_USER: 'lampuser',
        DB_PASSWORD: 'lamppassword',
        DB_NAME: 'lampdb',
      },
      logging: ecs.LogDriver.awsLogs({ streamPrefix: "php-apache" }),

      // ✅ 起動コマンドを設定（PHPファイル作成 & Apache 起動）
      command: [
        "/bin/sh",
        "-c",
        "echo \"<?php phpinfo(); ?>\" > /var/www/html/index.php && apache2-foreground"
      ],
    });


    phpContainer.addPortMappings({ 
      containerPort: 80,   // PHP-Apache 内部ポート
      hostPort: 8080       // ECS EC2 の外部ポート
    });

    phpContainer.addMountPoints({
      containerPath: "/var/www/html", // PHP-Apache のルートディレクトリ
      sourceVolume: "html-data",
      readOnly: false,
    });

    


    const ecsService = new ecs.Ec2Service(this, 'LampService', {
      cluster,
      taskDefinition,
    });
    const listener = alb.addListener('MyListener', {
      port: 80,
      open: true,
    });
    
    
    listener.addTargets('LampTarget', {
      targetGroupName: 'LampTargetGroup',
      protocol: elbv2.ApplicationProtocol.HTTP,
      port: 8888, // 🔥 リスナーのポートを80に設定
      targets: [asg], // 🔥 Auto Scaling Group をターゲットに指定
      healthCheck: {
        path: '/',
        interval: cdk.Duration.seconds(30),
      },
    });
    
    const phpMyAdminTargetGroup = new elbv2.ApplicationTargetGroup(this, 'PhpMyAdminTG', {
      vpc,
      protocol: elbv2.ApplicationProtocol.HTTP,
      port: 8080, // 🔥 ターゲットグループのポートを8080に設定
      targetType: elbv2.TargetType.INSTANCE, // EC2/ECS 用
      healthCheck: {
        path: '/',
        interval: cdk.Duration.seconds(30),
      },
    });
    phpMyAdminTargetGroup.addTarget(asg);
    
    new elbv2.ApplicationListenerRule(this, 'PhpMyAdminRule', {
      listener: listener,
      priority: 1, // 優先順位
      conditions: [elbv2.ListenerCondition.hostHeaders(['test.lamp.sano.ss-sre-admin.net'])], // `/phpmyadmin/*` へのリクエスト
      action: elbv2.ListenerAction.forward([phpMyAdminTargetGroup]), // `phpMyAdminTargetGroup` に転送
    });


    new cdk.CfnOutput(this, 'LoadBalancerDNS', {
      value: alb.loadBalancerDnsName,
    });


  }
}
