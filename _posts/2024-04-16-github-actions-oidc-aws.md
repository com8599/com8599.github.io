---
layout: post
title: GitHub Actions OIDC로 액세스 키 없이 AWS에 배포하기
date: 2024-04-16
tags: [infra]
description: 장기 액세스 키 대신 GitHub의 OIDC 토큰으로 IAM 역할을 맡아 배포하는 원리와 신뢰 정책, 워크플로 설정을 정리한다.
---

GitHub Actions에서 AWS에 배포하는 가장 흔한 방법은 IAM 사용자의 액세스 키를 만들어 저장소 시크릿(`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`)에 넣는 것이다. 간단하지만 이 키는 만료되지 않는다. 누군가 키를 빼내면 교체할 때까지 계속 쓸 수 있고, 저장소가 늘어날수록 같은 키가 여러 곳에 복사된다.

OIDC(OpenID Connect) 연동을 쓰면 저장소에 AWS 자격 증명을 아예 두지 않는다. 워크플로가 실행될 때마다 GitHub가 서명한 짧은 수명의 토큰을 발급하고, AWS STS가 그 토큰을 검증한 뒤 임시 자격 증명을 내준다.

## 동작 원리

등장하는 주체는 셋이다.

| 주체 | 역할 |
|---|---|
| GitHub OIDC 공급자(`token.actions.githubusercontent.com`) | 워크플로 실행마다 JWT(JSON Web Token)를 발급하고 서명 |
| AWS IAM OIDC 자격 증명 공급자(Identity Provider) | "이 발급자가 서명한 토큰을 신뢰한다"는 계정 수준 등록 |
| IAM 역할 | 신뢰 정책에서 어떤 토큰(저장소, 브랜치, 환경)을 받아들일지 조건으로 제한 |

흐름은 다음과 같다.

1. 잡(job)이 `id-token: write` 권한으로 GitHub에 OIDC 토큰을 요청한다.
2. GitHub가 저장소, 브랜치, 워크플로, 환경 등의 클레임(claim)을 담은 JWT를 서명해 돌려준다.
3. 워크플로가 `sts:AssumeRoleWithWebIdentity`에 이 토큰과 역할 ARN을 보낸다.
4. STS가 토큰의 서명과 발급자를 검증하고, 역할의 신뢰 정책 조건(`aud`, `sub`)을 평가한다.
5. 조건을 만족하면 임시 자격 증명(액세스 키, 시크릿 키, 세션 토큰)을 돌려준다.

토큰에는 발급자(`iss`), 대상(`aud`), 주체(`sub`) 외에도 `repository`, `ref`, `environment`, `workflow` 같은 실행 컨텍스트 클레임이 담긴다.

## sub 클레임의 형식

신뢰 정책의 핵심은 `sub`다. 형식은 워크플로가 어떻게 실행되었는지에 따라 달라진다.

| 상황 | `sub` 값 |
|---|---|
| 잡이 환경(environment)을 참조 | `repo:ORG/REPO:environment:production` |
| `pull_request` 이벤트 (환경 없음) | `repo:ORG/REPO:pull_request` |
| 브랜치 푸시 (환경·PR 아님) | `repo:ORG/REPO:ref:refs/heads/main` |
| 태그 푸시 (환경·PR 아님) | `repo:ORG/REPO:ref:refs/tags/v1.2.0` |

여기서 함정이 하나 있다. 잡에 `environment: production`을 지정하면 `sub`가 `ref:refs/heads/main` 형식이 아니라 `environment:production` 형식으로 바뀐다. 브랜치 조건만 걸어 둔 역할에 환경을 쓰는 잡을 연결하면 AssumeRole이 거부된다. 환경을 쓸 거라면 신뢰 정책도 환경 기준으로 작성한다.

## AWS 쪽 설정 1: OIDC 공급자 등록

계정마다 한 번만 등록한다. IAM 콘솔의 자격 증명 공급자에서 다음 값으로 OpenID Connect 공급자를 추가한다.

- 공급자 URL: `https://token.actions.githubusercontent.com`
- 대상(Audience): `sts.amazonaws.com` (공식 `configure-aws-credentials` 액션을 쓸 때)

예전 자료에는 GitHub 인증서의 썸프린트(thumbprint)를 직접 구해 등록하라는 안내와, 중간 인증서가 바뀌어 썸프린트를 추가해야 했다는 공지가 남아 있다. 2023년 7월 GitHub 공지에 따르면 이후 AWS는 GitHub OIDC 공급자와의 통신을 썸프린트 대신 신뢰하는 루트 인증 기관(CA) 목록으로 검증하며, 고객이 따로 조치할 필요는 없다. IAM 문서도 JWKS 엔드포인트의 TLS 인증서가 AWS가 신뢰하는 CA로 서명된 경우에는 그 CA 라이브러리로 검증하고, 그렇지 않을 때만 썸프린트를 쓴다고 설명한다. 콘솔에서 공급자를 만들면 썸프린트는 IAM이 자동으로 가져와 채운다. 정리하면 GitHub 연동에서는 인증서 교체에 맞춰 썸프린트를 갱신하던 작업이 더 이상 필요 없다.

## AWS 쪽 설정 2: 역할과 신뢰 정책

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::111122223333:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": "repo:my-org/api-server:ref:refs/heads/main"
        }
      }
    }
  ]
}
```

- `Action`은 일반 역할의 `sts:AssumeRole`이 아니라 `sts:AssumeRoleWithWebIdentity`다.
- `aud` 조건은 이 토큰이 STS용으로 발급된 것인지 확인한다.
- `sub` 조건이 실제 보안 경계다. `token.actions.githubusercontent.com`은 모든 GitHub 사용자가 공유하는 발급자이므로, `sub`를 제한하지 않으면 **다른 조직의 워크플로도 이 역할을 맡을 수 있다**. AWS 문서도 이 점을 경고하며 특정 저장소나 브랜치로 제한할 것을 권한다.

와일드카드가 필요하면 `StringLike`를 쓴다.

```json
"Condition": {
  "StringEquals": {
    "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
  },
  "StringLike": {
    "token.actions.githubusercontent.com:sub": "repo:my-org/api-server:*"
  }
}
```

| `sub` 조건 | 허용 범위 | 권장 여부 |
|---|---|---|
| `repo:my-org/api-server:ref:refs/heads/main` | 한 저장소의 main 브랜치 | 운영 배포 역할에 권장 |
| `repo:my-org/api-server:environment:production` | 한 저장소의 production 환경 | 환경 보호 규칙과 함께 쓸 때 권장 |
| `repo:my-org/api-server:*` | 한 저장소의 모든 브랜치, PR | 읽기 전용이나 개발 환경 역할 |
| `repo:my-org/*` | 조직의 모든 저장소 | 넓음. 피한다 |
| 조건 없음 또는 `*` | 모든 GitHub 사용자 | 절대 금지 |

`repo:my-org/api-server:*`는 PR 워크플로까지 포함한다는 점에 주의한다. 포크에서 올라온 PR이나 아직 리뷰되지 않은 브랜치의 코드가 운영 배포 권한을 얻으면 안 된다. 운영 배포 역할은 main 브랜치나 보호 규칙이 걸린 환경으로 좁힌다. 환경을 기준으로 할 때는 GitHub 쪽에서 환경에 배포 가능한 브랜치 제한과 승인자(required reviewers)를 설정해야 조건이 의미를 가진다.

역할의 권한 정책은 배포에 필요한 것만 준다. ECS 배포라면 ECR 푸시, 태스크 정의 등록, 서비스 업데이트, 그리고 태스크 정의에 지정한 역할들에 대한 `iam:PassRole` 정도다.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": "ecr:GetAuthorizationToken", "Resource": "*" },
    {
      "Effect": "Allow",
      "Action": [
        "ecr:BatchCheckLayerAvailability",
        "ecr:InitiateLayerUpload",
        "ecr:UploadLayerPart",
        "ecr:CompleteLayerUpload",
        "ecr:PutImage"
      ],
      "Resource": "arn:aws:ecr:ap-northeast-2:111122223333:repository/api"
    },
    {
      "Effect": "Allow",
      "Action": ["ecs:RegisterTaskDefinition", "ecs:DescribeTaskDefinition"],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": ["ecs:UpdateService", "ecs:DescribeServices"],
      "Resource": "arn:aws:ecs:ap-northeast-2:111122223333:service/prod/api"
    },
    {
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": [
        "arn:aws:iam::111122223333:role/ecsTaskExecutionRole",
        "arn:aws:iam::111122223333:role/api-task-role"
      ]
    }
  ]
}
```

## 워크플로 설정

워크플로에서 필요한 것은 두 가지다. OIDC 토큰을 발급받을 수 있는 `id-token: write` 권한과, 토큰을 STS 자격 증명으로 바꿔 주는 `aws-actions/configure-aws-credentials` 액션(2024년 4월 기준 메이저 버전 v4)이다.

```yaml
name: deploy

on:
  push:
    branches: [main]

permissions:
  id-token: write
  contents: read

env:
  AWS_REGION: ap-northeast-2
  ECR_REPOSITORY: api

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::111122223333:role/github-actions-deploy
          role-session-name: api-deploy
          aws-region: ap-northeast-2

      - name: Build and push image
        run: |
          ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
          REGISTRY="$ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com"
          aws ecr get-login-password --region "$AWS_REGION" \
            | docker login --username AWS --password-stdin "$REGISTRY"
          docker build -t "$REGISTRY/$ECR_REPOSITORY:$GITHUB_SHA" .
          docker push "$REGISTRY/$ECR_REPOSITORY:$GITHUB_SHA"
          echo "IMAGE=$REGISTRY/$ECR_REPOSITORY:$GITHUB_SHA" >> "$GITHUB_ENV"

      - name: Deploy to ECS
        run: |
          aws ecs describe-task-definition --task-definition api \
            --query taskDefinition > current.json
          jq --arg IMAGE "$IMAGE" '
            .containerDefinitions[0].image = $IMAGE
            | del(.taskDefinitionArn, .revision, .status, .requiresAttributes,
                  .compatibilities, .registeredAt, .registeredBy)
          ' current.json > taskdef.json
          aws ecs register-task-definition --cli-input-json file://taskdef.json
          aws ecs update-service --cluster prod --service api --task-definition api
          aws ecs wait services-stable --cluster prod --services api
```

몇 가지 짚을 점이 있다.

- `permissions`를 명시하면 나열하지 않은 권한은 모두 `none`이 된다. 그래서 `id-token: write`만 쓰면 `actions/checkout`이 저장소를 읽지 못하므로 `contents: read`를 함께 적는다.
- `id-token: write`는 저장소나 리소스에 대한 쓰기 권한이 아니라 OIDC 토큰을 요청할 권한일 뿐이다.
- `role-session-name`은 CloudTrail에 남는 세션 이름이다. 어떤 워크플로가 어떤 작업을 했는지 추적할 수 있게 의미 있는 값을 준다.
- `aws-actions/amazon-ecr-login`, `amazon-ecs-render-task-definition`, `amazon-ecs-deploy-task-definition` 같은 공식 액션으로 빌드·배포 단계를 대체할 수도 있다. 위 예시는 같은 작업을 AWS CLI로 풀어 쓴 것이다.
- 공급망 공격을 줄이려면 서드파티 액션을 태그 대신 커밋 SHA로 고정한다. GitHub 문서의 예제도 `configure-aws-credentials`를 SHA로 고정해 보여 준다.

## 장기 액세스 키와 비교

| 항목 | IAM 사용자 액세스 키 | OIDC + IAM 역할 |
|---|---|---|
| 저장소에 저장하는 비밀 | 액세스 키 ID, 시크릿 키 | 없음 (역할 ARN은 비밀이 아님) |
| 자격 증명 수명 | 삭제·비활성화할 때까지 | 역할 세션 동안만 유효한 임시 자격 증명 |
| 교체(rotation) | 직접 해야 함 | 필요 없음 |
| 사용 범위 제한 | 키를 가진 누구나 어디서든 사용 | 신뢰 정책의 `sub` 조건으로 저장소·브랜치·환경 제한 |
| 유출 시 영향 | 키가 무효화될 때까지 계속 악용 가능 | 토큰과 세션이 짧아 피해 시간이 제한됨 |
| 감사 | 사용자 이름만 남음 | 역할 세션 이름과 함께 CloudTrail에 기록 |
| 초기 설정 | 간단 | OIDC 공급자와 신뢰 정책 작성 필요 |

OIDC로 옮긴 뒤에는 기존 IAM 사용자의 액세스 키를 비활성화하고, 일정 기간 CloudTrail에서 사용 기록이 없는지 확인한 뒤 삭제한다. 저장소 시크릿에 남아 있는 키도 함께 지운다.

## 자주 만나는 오류

| 증상 | 원인 |
|---|---|
| OIDC 토큰 요청 단계에서 자격 증명을 불러오지 못함 | `id-token: write` 권한 누락 |
| `Not authorized to perform sts:AssumeRoleWithWebIdentity` | `sub` 조건 불일치. 환경을 쓰는 잡인데 브랜치 조건만 있거나, 오타 |
| 같은 오류, PR에서만 발생 | PR의 `sub`는 `pull_request` 형식이라 브랜치 조건과 맞지 않음 |
| `No OpenIDConnect provider found` | 해당 계정에 OIDC 공급자가 등록되지 않았거나 역할의 `Federated` ARN이 다른 계정을 가리킴 |
| 포크 PR에서 토큰을 받지 못함 | 포크에서 온 `pull_request` 워크플로는 쓰기 권한이 읽기 전용으로 조정되어 `id-token: write`도 적용되지 않음 |

`sub` 불일치를 디버깅할 때는 토큰의 실제 클레임을 확인하는 것이 가장 빠르다. 신뢰 정책을 추측해서 고치기보다, 워크플로가 받은 `sub` 값을 기준으로 조건을 맞춘다.

## 정리

1. OIDC 연동은 저장소에 AWS 키를 두지 않고, 실행마다 GitHub가 발급한 JWT를 STS가 검증해 임시 자격 증명을 내주는 방식이다.
2. AWS 계정에 `token.actions.githubusercontent.com` 공급자를 한 번 등록하고, 대상은 `sts.amazonaws.com`으로 둔다. GitHub 연동에서 썸프린트는 AWS가 신뢰 CA로 검증하므로 관리하지 않아도 된다.
3. 역할의 신뢰 정책은 `sts:AssumeRoleWithWebIdentity`를 허용하고 `aud`와 `sub` 조건을 반드시 건다. `sub`를 제한하지 않으면 다른 조직도 역할을 맡을 수 있다.
4. `sub` 형식은 환경, PR, 브랜치, 태그에 따라 다르며, 잡에 환경을 지정하면 환경 형식이 우선한다.
5. 워크플로에는 `permissions: id-token: write`와 `contents: read`를 주고 `configure-aws-credentials@v4`로 역할을 맡는다.
6. 운영 배포 역할은 main 브랜치나 보호된 환경으로 좁히고, 권한 정책은 배포에 필요한 리소스로만 제한한다.
