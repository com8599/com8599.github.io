---
layout: post
title: ECS와 ECR로 컨테이너 배포하기 — 태스크 정의, 서비스, 클러스터
date: 2024-03-05
tags: [infra]
description: ECS의 클러스터·태스크 정의·태스크·서비스 관계와 Fargate/EC2 차이, 두 IAM 역할, ECR 푸시와 이미지 정리 정책을 정리한다.
---

Docker 이미지를 만들었다면 다음 질문은 "어디서, 몇 개를, 어떻게 계속 띄워 둘 것인가"다. Amazon ECS(Elastic Container Service)는 이 질문에 답하는 AWS의 컨테이너 오케스트레이션 서비스이고, Amazon ECR(Elastic Container Registry)은 그 이미지를 보관하는 프라이빗 레지스트리다. 이 글은 ECS를 구성하는 개념들의 관계, 실행 환경 선택, 권한 구조, 그리고 ECR에 이미지를 올리고 관리하는 흐름을 다룬다.

## 네 가지 개념의 관계

ECS에서 가장 먼저 구분해야 할 것은 클러스터, 태스크 정의, 태스크, 서비스다.

| 개념 | 역할 | 비유 |
|---|---|---|
| 클러스터(Cluster) | 태스크와 서비스가 실행되는 논리적 그룹 | 작업 공간 |
| 태스크 정의(Task Definition) | 어떤 이미지를, 얼마의 CPU·메모리로, 어떤 포트·환경 변수로 실행할지 적은 JSON 명세 | 설계도 |
| 태스크(Task) | 태스크 정의를 실제로 실행한 인스턴스. 하나 이상의 컨테이너로 구성 | 설계도로 만든 제품 |
| 서비스(Service) | 지정한 개수(`desiredCount`)의 태스크를 계속 유지하고, 로드 밸런서와 연결하고, 배포를 관리 | 생산 라인 관리자 |

태스크 정의는 `family`라는 이름 아래 버전이 쌓인다. 같은 family로 처음 등록하면 리비전(revision) 1이 되고, 이후 등록할 때마다 번호가 하나씩 올라간다. 그래서 태스크 정의는 `api:1`, `api:2`처럼 `family:revision`으로 가리킨다. 등록된 리비전은 수정할 수 없고, 바꾸려면 새 리비전을 등록한다.

태스크를 직접 `RunTask`로 띄우면 한 번 실행하고 끝나는 배치 작업에 가깝다. 반면 서비스는 태스크가 죽으면 다시 띄워 `desiredCount`를 유지한다. API 서버처럼 항상 떠 있어야 하는 워크로드는 서비스로 운영한다. 서비스를 업데이트한다는 것은 대부분 "새 태스크 정의 리비전으로 교체한다"는 뜻이다.

## 태스크 정의 예시

Fargate에서 실행하는 Spring Boot API의 태스크 정의다.

```json
{
  "family": "api",
  "requiresCompatibilities": ["FARGATE"],
  "networkMode": "awsvpc",
  "cpu": "512",
  "memory": "1024",
  "executionRoleArn": "arn:aws:iam::111122223333:role/ecsTaskExecutionRole",
  "taskRoleArn": "arn:aws:iam::111122223333:role/api-task-role",
  "containerDefinitions": [
    {
      "name": "api",
      "image": "111122223333.dkr.ecr.ap-northeast-2.amazonaws.com/api:3f2c1ab",
      "essential": true,
      "portMappings": [{ "containerPort": 8080, "protocol": "tcp" }],
      "environment": [{ "name": "SPRING_PROFILES_ACTIVE", "value": "prod" }],
      "secrets": [
        {
          "name": "DB_PASSWORD",
          "valueFrom": "arn:aws:secretsmanager:ap-northeast-2:111122223333:secret:prod/db-AbCdEf"
        }
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/api",
          "awslogs-region": "ap-northeast-2",
          "awslogs-stream-prefix": "api"
        }
      }
    }
  ]
}
```

Fargate 태스크는 `networkMode`가 반드시 `awsvpc`이고, 태스크 수준의 `cpu`와 `memory`를 정해진 조합 안에서 지정해야 한다. 예를 들어 `256`(0.25 vCPU)은 메모리 512 MiB·1 GB·2 GB 중 하나, `512`(0.5 vCPU)는 1~4 GB 중 하나를 고른다. `awsvpc` 모드에서는 태스크마다 별도의 ENI(Elastic Network Interface)가 붙고, `portMappings`에는 `containerPort`만 적는다.

## 시작 유형: Fargate와 EC2

태스크가 실제로 실행될 컴퓨팅 자원을 시작 유형(Launch Type)이라고 한다.

| 항목 | Fargate | EC2 |
|---|---|---|
| 서버 관리 | 없음. AWS가 호스트를 관리 | EC2 인스턴스, AMI, ECS 에이전트를 직접 관리 |
| 용량 계획 | 태스크 단위로 CPU·메모리만 지정 | 인스턴스 크기와 개수, 빈 공간(bin packing)을 고려 |
| 과금 | 태스크가 요청한 vCPU·메모리 기준 | 실행 중인 EC2 인스턴스 기준 |
| 네트워크 모드 | `awsvpc`만 지원 | `awsvpc`, `bridge`, `host` 등 |
| 격리 | 태스크마다 커널·ENI를 공유하지 않는 독립 경계 | 같은 인스턴스의 태스크가 호스트를 공유 |
| 적합한 경우 | 트래픽이 크지 않은 API, 운영 인력이 적은 팀 | GPU, 특수 인스턴스 타입, 높은 사용률로 비용을 최적화할 때 |

AWS 문서도 엄격한 격리가 필요한 워크로드에는 Fargate를 권한다. EC2 시작 유형에서는 같은 인스턴스의 컨테이너가 인스턴스 메타데이터나 다른 태스크의 자격 증명에 접근할 수 있으므로 추가 설정이 필요하다. 반대로 인스턴스를 꽉 채워 쓸 수 있을 만큼 부하가 일정하다면 EC2가 단가 면에서 유리할 수 있다. 작은 팀이 처음 시작할 때는 서버 패치와 용량 계획을 덜어 주는 Fargate가 무난한 선택이다.

## 두 개의 IAM 역할

태스크 정의에는 IAM 역할을 두 개 지정할 수 있고, 이름이 비슷해 가장 자주 헷갈린다.

| 구분 | 태스크 실행 역할(Task Execution Role) | 태스크 역할(Task Role) |
|---|---|---|
| 필드 | `executionRoleArn` | `taskRoleArn` |
| 사용 주체 | ECS 컨테이너 에이전트와 Fargate 에이전트 | 컨테이너 안의 애플리케이션 코드 |
| 용도 | ECR 이미지 풀, `awslogs`로 CloudWatch Logs 전송, Secrets Manager·Parameter Store 값 주입 | S3, SQS, DynamoDB 등 애플리케이션이 호출하는 AWS API |
| 컨테이너에서 접근 | 불가 | AWS SDK의 컨테이너 자격 증명 공급자로 자동 사용 |
| 관리형 정책 | `AmazonECSTaskExecutionRolePolicy` | 없음. 필요한 권한만 직접 작성 |

두 역할 모두 신뢰 정책의 주체는 `ecs-tasks.amazonaws.com`이다.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Service": "ecs-tasks.amazonaws.com" },
      "Action": "sts:AssumeRole"
    }
  ]
}
```

판단 기준은 단순하다. **컨테이너가 뜨기 전에 필요한 권한**(이미지 풀, 로그 그룹, `secrets` 주입)은 실행 역할에, **컨테이너가 뜬 뒤 코드가 쓰는 권한**은 태스크 역할에 둔다. 위 예시에서 `secrets`로 DB 비밀번호를 주입하므로 실행 역할에 해당 시크릿에 대한 `secretsmanager:GetSecretValue`를 추가해야 한다. 반면 애플리케이션이 S3에 파일을 올린다면 `s3:PutObject`는 태스크 역할에 넣는다.

태스크 역할을 지정하면 컨테이너 안의 AWS SDK와 CLI는 그 역할의 자격 증명만 사용하고, EC2 인스턴스 프로파일의 권한은 상속하지 않는다. Fargate에는 애초에 컨테이너가 쓸 인스턴스 프로파일이 없으므로, 애플리케이션이 AWS API를 호출한다면 태스크 역할이 필수다. 서비스마다 역할을 따로 만들어 최소 권한으로 유지한다.

## ECR에 이미지 푸시하기

ECR 레지스트리 주소는 `<계정 ID>.dkr.ecr.<리전>.amazonaws.com` 형식이고, 그 아래에 리포지토리를 만든다. 푸시하기 전에 리포지토리가 존재해야 한다.

```bash
ACCOUNT_ID=111122223333
REGION=ap-northeast-2
REGISTRY="$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com"
TAG=$(git rev-parse --short HEAD)

aws ecr create-repository \
  --repository-name api \
  --image-tag-mutability IMMUTABLE \
  --region "$REGION"

aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "$REGISTRY"

docker build -t api:"$TAG" .
docker tag api:"$TAG" "$REGISTRY/api:$TAG"
docker push "$REGISTRY/api:$TAG"
```

`get-login-password`가 돌려주는 인증 토큰은 12시간 동안 유효하고, 레지스트리마다 따로 받아야 한다. `docker login`의 사용자 이름은 항상 `AWS`다. 태그를 생략하면 `latest`로 간주된다.

ECS 쪽에서 이미지를 가져오는 것은 앞에서 본 태스크 실행 역할이다. 관리형 정책 `AmazonECSTaskExecutionRolePolicy`에 `ecr:GetAuthorizationToken`, `ecr:BatchGetImage`, `ecr:GetDownloadUrlForLayer` 등이 이미 포함되어 있다.

## 태그 불변성(Tag Immutability)

리포지토리의 태그 변경 가능성 설정은 `MUTABLE`(기본값)과 `IMMUTABLE` 두 가지다. `IMMUTABLE`로 두면 이미 존재하는 태그로 이미지를 푸시할 때 `ImageTagAlreadyExistsException` 오류가 나며, 이 설정은 리포지토리의 모든 태그에 적용된다.

```bash
aws ecr put-image-tag-mutability \
  --repository-name api \
  --image-tag-mutability IMMUTABLE
```

| 태그 전략 | MUTABLE | IMMUTABLE |
|---|---|---|
| `latest` 하나로 덮어쓰기 | 가능. 하지만 어떤 코드가 떠 있는지 태그로 알 수 없음 | 두 번째 푸시부터 실패 |
| Git 커밋 SHA 태그 | 가능 | 권장. 태그와 코드가 1:1로 고정 |
| 롤백 | 이전 이미지를 같은 태그로 다시 푸시해야 할 수 있음 | 이전 리비전의 태스크 정의로 되돌리면 끝 |

불변 태그를 쓰면 태스크 정의 리비전 하나가 정확히 하나의 이미지를 가리키므로, "리비전 41로 롤백"이 곧 "커밋 3f2c1ab로 롤백"이 된다. 그래서 커밋 SHA나 빌드 번호처럼 한 번만 쓰이는 태그와 `IMMUTABLE` 설정을 함께 쓴다. 가변 태그를 쓰면 같은 태스크 정의 리비전이라도 태스크가 새로 뜨는 시점(스케일 아웃, 장애 복구)에 따라 다른 이미지를 가져올 수 있다.

## 수명 주기 정책(Lifecycle Policy)으로 이미지 정리

커밋마다 이미지를 푸시하면 리포지토리는 계속 커지고 저장 비용도 늘어난다. 수명 주기 정책은 규칙에 맞는 이미지를 자동으로 만료(삭제)한다.

```json
{
  "rules": [
    {
      "rulePriority": 1,
      "description": "태그 없는 이미지는 7일 후 삭제",
      "selection": {
        "tagStatus": "untagged",
        "countType": "sinceImagePushed",
        "countUnit": "days",
        "countNumber": 7
      },
      "action": { "type": "expire" }
    },
    {
      "rulePriority": 2,
      "description": "최근 50개만 유지",
      "selection": {
        "tagStatus": "any",
        "countType": "imageCountMoreThan",
        "countNumber": 50
      },
      "action": { "type": "expire" }
    }
  ]
}
```

```bash
aws ecr put-lifecycle-policy \
  --repository-name api \
  --lifecycle-policy-text file://lifecycle.json
```

규칙을 읽는 방법은 다음과 같다.

- `rulePriority`는 숫자가 작을수록 먼저 적용된다. 모든 규칙을 동시에 평가한 뒤 우선순위대로 적용하며, 한 이미지는 최대 하나의 규칙에 의해서만 만료된다.
- `tagStatus`는 `tagged`, `untagged`, `any` 중 하나다. `tagged`를 쓰면 `tagPrefixList` 같은 태그 조건을 함께 줘야 하고, `any` 규칙은 가장 큰 `rulePriority`를 가져 마지막에 평가되어야 한다.
- `countType`이 `imageCountMoreThan`이면 푸시 시각 기준으로 최신순 정렬 후 개수를 넘는 오래된 이미지를, `sinceImagePushed`이면 지정한 일수보다 오래된 이미지를 만료한다. `countUnit`은 `sinceImagePushed`일 때만 쓴다.
- 조건을 만족한 이미지는 24시간 안에 만료된다. 적용 전에는 콘솔의 미리 보기(preview)로 어떤 이미지가 지워질지 확인한다.

주의할 점은 **롤백에 필요한 이미지까지 지우지 않는 것**이다. 서비스가 아직 참조하는 이미지가 지워지면 이후 새 태스크를 띄울 때 이미지를 가져오지 못한다. 유지 개수는 배포 빈도와 롤백할 수 있어야 하는 기간을 기준으로 넉넉하게 잡는다.

## 배포 흐름 요약

이미지를 만든 뒤 서비스에 반영하기까지의 순서는 다음과 같다.

1. 이미지를 빌드하고 커밋 SHA 태그로 ECR에 푸시한다.
2. 태스크 정의의 `image`를 새 태그로 바꿔 새 리비전을 등록한다(`aws ecs register-task-definition`).
3. 서비스가 새 리비전을 쓰도록 업데이트한다(`aws ecs update-service --task-definition api:42`).
4. 서비스 스케줄러가 배포 설정에 따라 새 태스크를 띄우고 기존 태스크를 내린다.

```bash
aws ecs register-task-definition --cli-input-json file://taskdef.json
aws ecs update-service --cluster prod --service api --task-definition api
aws ecs wait services-stable --cluster prod --services api
```

`--task-definition`에 리비전 없이 family만 주면 가장 최신의 ACTIVE 리비전이 사용된다. 4단계에서 기존 태스크를 언제, 몇 개씩 내리는지는 배포 설정과 헬스 체크가 결정하며, 이 부분은 다음 글인 무중단 배포에서 이어서 다룬다.

## 정리

1. 태스크 정의는 실행 명세, 태스크는 그 실행 결과, 서비스는 태스크 개수와 배포를 관리하는 주체, 클러스터는 이들을 묶는 논리 그룹이다.
2. 태스크 정의는 `family:revision`으로 버전이 쌓이고 수정할 수 없으며, 변경은 새 리비전 등록으로 한다.
3. Fargate는 `awsvpc` 모드와 정해진 CPU·메모리 조합을 요구하는 대신 호스트 관리가 없고, EC2는 관리 부담이 있는 대신 인스턴스 선택과 사용률 최적화가 자유롭다.
4. 이미지 풀·로그·시크릿 주입은 태스크 실행 역할, 애플리케이션의 AWS API 호출은 태스크 역할에 권한을 준다.
5. ECR은 커밋 SHA 같은 고유 태그와 `IMMUTABLE` 설정을 함께 써서 리비전과 이미지를 1:1로 고정한다.
6. 수명 주기 정책으로 태그 없는 이미지와 오래된 이미지를 정리하되, 롤백에 필요한 이미지는 남을 만큼 여유를 둔다.
