---
layout: post
title: ECS 무중단 배포 — 롤링 업데이트, 헬스 체크 유예, 배포 서킷 브레이커(Deployment Circuit Breaker)
date: 2024-03-26
tags: [infra]
description: ECS 롤링 업데이트에서 요청이 끊기지 않도록 배포 비율, 헬스 체크, 등록 취소 지연, 종료 신호 처리, 서킷 브레이커를 맞추는 방법.
---

ECS 서비스에 새 태스크 정의 리비전을 배포하면 서비스 스케줄러가 새 태스크를 띄우고 기존 태스크를 내린다(클러스터·태스크 정의·서비스의 관계는 [이전 글](/2024/03/05/ecs-ecr-basics/) 참고). 기본 설정만으로도 배포는 되지만, 배포 중에 502가 몇 건씩 섞이거나, 부팅이 느린 애플리케이션이 계속 재시작되거나, 깨진 이미지가 몇 시간 동안 재시도되는 일이 생긴다. 이 글은 롤링 업데이트(Rolling Update) 배포 컨트롤러(`ECS`)를 기준으로, 이런 문제를 만드는 설정 값과 그 원리를 정리한다.

## 롤링 업데이트의 두 비율

롤링 업데이트에서 한 번에 몇 개의 태스크를 교체할지는 서비스의 배포 설정 두 값으로 정해진다.

| 파라미터 | 의미 | 반올림 | 기본값 |
|---|---|---|---|
| `minimumHealthyPercent` | 배포 중 **실행 중이고 정상인** 태스크의 하한, `desiredCount` 대비 비율 | 올림 | 100 |
| `maximumPercent` | 배포 중 **실행 중인** 태스크의 상한, `desiredCount` 대비 비율 | 내림 | 200 |

`desiredCount`가 4일 때 조합별 동작은 다음과 같다.

| 설정(min/max) | 하한/상한 | 동작 | 특징 |
|---|---|---|---|
| 100 / 200 | 4 / 8 | 새 태스크 4개를 먼저 띄우고, 정상이 되면 기존 4개를 내림 | 용량이 줄지 않음, 순간적으로 두 배 자원 필요 |
| 50 / 100 | 2 / 4 | 기존 2개를 먼저 내리고 새 2개를 띄우는 식으로 교체 | 추가 자원 없음, 배포 중 용량 절반 |
| 100 / 150 | 4 / 6 | 새 태스크 2개씩 띄우고 기존 2개씩 내림 | 절충 |
| 100 / 100 | 4 / 4 | 아무것도 멈추거나 시작할 수 없어 배포가 진행되지 않음 | 잘못된 설정 |

마지막 행처럼 스케줄러가 태스크를 하나도 멈추거나 시작할 수 없는 조합이면 배포가 멈추고 서비스 이벤트로 경고가 남는다. 반올림 방향도 주의한다. `desiredCount`가 2이고 `minimumHealthyPercent`가 75면 하한이 1.5를 올림한 2가 되어 기존 태스크를 하나도 내릴 수 없고, 이때는 `maximumPercent`로 여유 태스크를 먼저 띄울 수 있어야 한다.

Fargate라면 호스트 용량을 걱정할 필요가 없으므로 `100 / 200`이 가장 안전하다. EC2 시작 유형에서 인스턴스에 여유 공간이 없다면 `maximumPercent`를 올려도 새 태스크가 배치되지 못하므로, 그때는 `minimumHealthyPercent`를 낮춰 먼저 자리를 비우는 쪽을 택한다.

## "정상"의 기준: 헬스 체크

`minimumHealthyPercent`의 "정상"은 상황에 따라 다르다. 로드 밸런서를 쓰지 않는 서비스는 `RUNNING` 상태면 정상으로 보고, 로드 밸런서를 쓰는 서비스는 `RUNNING`이면서 로드 밸런서가 정상(healthy)으로 보고해야 정상으로 본다. 컨테이너 헬스 체크를 정의했다면 그것도 판단에 들어간다.

ALB(Application Load Balancer) 대상 그룹(target group)의 헬스 체크 기본값은 다음과 같다(대상 유형 `ip`·`instance` 기준).

| 설정 | 기본값 | 범위 |
|---|---|---|
| `HealthCheckPath` | `/` | |
| `HealthCheckIntervalSeconds` | 30초 | 5–300 |
| `HealthCheckTimeoutSeconds` | 5초 | 2–120 |
| `HealthyThresholdCount` | 5 | 2–10 |
| `UnhealthyThresholdCount` | 2 | 2–10 |
| `Matcher` | 200 | 200–499 |

새로 등록된 대상은 헬스 체크를 한 번 통과하면 정상이 된다. 반면 한번 비정상이 된 대상이 다시 정상으로 돌아오려면 `HealthyThresholdCount`만큼 연속 성공해야 하므로, 기본값으로는 30초 간격 5회, 약 2분 30초가 걸린다. 비정상 판정은 연속 2회 실패, 약 1분이면 내려진다. 헬스 체크 경로는 애플리케이션이 실제로 요청을 처리할 수 있는 상태를 반영해야 한다. Spring Boot라면 Actuator의 readiness 그룹을 쓰는 것이 일반적이다.

```properties
management.endpoint.health.probes.enabled=true
management.endpoints.web.exposure.include=health
```

이 설정으로 `/actuator/health/readiness`가 노출되고, 대상 그룹의 `HealthCheckPath`를 이 경로로 지정한다. DB나 외부 API 같은 의존성을 헬스 체크에 넣을지는 신중히 판단한다. 외부 의존성 하나가 느려졌을 때 모든 태스크가 동시에 비정상으로 판정되어 교체되는 연쇄 장애가 생길 수 있다.

## 헬스 체크 유예 기간

JVM 애플리케이션은 컨테이너가 시작된 뒤 실제로 요청을 받기까지 수십 초가 걸린다. 그 사이 ALB 헬스 체크가 연속 실패하면 ECS는 태스크를 비정상으로 보고 멈춘 뒤 새로 띄운다. 새 태스크도 똑같이 부팅 중에 실패하므로 배포가 영원히 끝나지 않는다.

서비스의 `healthCheckGracePeriodSeconds`는 태스크가 처음 시작된 뒤 지정한 시간 동안 ECS 서비스 스케줄러가 로드 밸런서와 컨테이너 헬스 체크의 비정상 결과를 무시하게 한다. 지정하지 않으면 0이다.

```bash
aws ecs update-service \
  --cluster prod \
  --service api \
  --health-check-grace-period-seconds 90
```

유예 기간은 "스케줄러가 비정상 결과를 무시하는 시간"일 뿐, 로드 밸런서가 트래픽을 보내는지 여부와는 별개다. ALB는 자기 헬스 체크를 통과한 대상에만 트래픽을 보낸다. 따라서 유예 기간은 부팅 시간의 최댓값보다 조금 길게 잡되, 너무 길면 정말로 망가진 태스크도 그 시간 동안 교체되지 않는다는 점을 감안한다.

컨테이너 헬스 체크를 쓴다면 태스크 정의의 `healthCheck.startPeriod`(0–300초, 기본 비활성)도 같은 역할을 한다. 이 기간 안의 실패는 재시도 횟수에 포함되지 않는다.

## 내려가는 태스크: 등록 취소와 종료 신호

새 태스크를 올리는 쪽보다 놓치기 쉬운 것이 기존 태스크를 내리는 쪽이다. 서비스 태스크가 멈출 때의 순서는 다음과 같다.

1. **DEACTIVATING**: ECS가 대상 그룹에서 태스크의 등록을 취소한다. ALB는 이 대상을 `draining` 상태로 바꾸고 새 요청을 보내지 않는다.
2. 등록 취소 지연(Deregistration Delay) 동안 처리 중인 요청이 끝나기를 기다린다. 기본값은 300초다. 처리 중인 요청과 연결이 없으면 지연을 기다리지 않고 바로 완료된다.
3. **STOPPING**: 컨테이너 에이전트가 컨테이너에 `SIGTERM`(이미지의 `STOPSIGNAL`, 기본 `SIGTERM`)을 보낸다.
4. 태스크 정의의 `stopTimeout`만큼 기다린 뒤에도 종료되지 않으면 `SIGKILL`을 보낸다.

| 설정 | 위치 | 기본값 | 의미 |
|---|---|---|---|
| `deregistration_delay.timeout_seconds` | 대상 그룹 속성 | 300초 | ALB가 처리 중인 요청을 기다리는 시간 |
| `stopTimeout` | 컨테이너 정의 | 30초 (Fargate 최대 120초) | `SIGTERM` 후 `SIGKILL`까지의 유예 |
| `server.shutdown=graceful` | Spring Boot | 비활성(즉시 종료) | `SIGTERM` 수신 시 새 요청을 거부하고 처리 중 요청을 마침 |
| `spring.lifecycle.timeout-per-shutdown-phase` | Spring Boot | 30초 | 그레이스풀 셧다운 최대 대기 시간 |

기본 등록 취소 지연 300초는 API 서버에는 대개 너무 길다. 응답 시간이 수 초 이내인 API라면 30~60초로 줄여도 충분하고, 그만큼 배포가 빨라진다. 지연 시간 안에 대상이 연결을 먼저 끊어 버리면 클라이언트는 5xx 응답을 받으므로, 지연 시간은 가장 긴 요청의 처리 시간보다 길어야 한다.

애플리케이션 쪽에서는 `SIGTERM`을 받았을 때 즉시 죽지 않고 처리 중인 요청을 마무리해야 한다. Spring Boot는 다음 설정으로 그레이스풀 셧다운(Graceful Shutdown)을 켠다.

```yaml
server:
  shutdown: graceful
spring:
  lifecycle:
    timeout-per-shutdown-phase: 20s
```

시간 값은 `애플리케이션 종료 대기(20초) < stopTimeout(30초)` 관계를 지켜야 한다. 애플리케이션이 정리를 끝내기 전에 `SIGKILL`이 오면 그레이스풀 셧다운 설정은 의미가 없다. 또 Dockerfile이 `sh -c "java ..."`처럼 셸을 PID 1로 두면 셸이 `SIGTERM`을 자바 프로세스에 전달하지 않을 수 있으므로, `ENTRYPOINT ["java", "-jar", "app.jar"]`처럼 exec 형식으로 실행한다.

```json
{
  "name": "api",
  "image": "111122223333.dkr.ecr.ap-northeast-2.amazonaws.com/api:3f2c1ab",
  "stopTimeout": 30,
  "healthCheck": {
    "command": ["CMD-SHELL", "curl -fs http://localhost:8080/actuator/health/readiness || exit 1"],
    "interval": 15,
    "timeout": 5,
    "retries": 3,
    "startPeriod": 60
  }
}
```

`CMD-SHELL` 헬스 체크는 컨테이너 안에서 실행되므로 이미지에 `curl`이 있어야 한다. 슬림 이미지라면 ALB 헬스 체크만 쓰는 편이 단순하다.

## 배포 서킷 브레이커

새 이미지가 시작하자마자 죽는다면 어떻게 될까. 서킷 브레이커가 없으면 서비스 스케줄러는 새 태스크를 계속 띄우고 실패하기를 반복한다. `minimumHealthyPercent`가 100이면 기존 태스크는 살아 있으므로 장애는 아니지만, 배포는 끝나지 않고 상태도 실패로 바뀌지 않는다.

배포 서킷 브레이커는 롤링 업데이트(`ECS` 배포 컨트롤러)에서만 쓸 수 있고, 배포 실패를 두 단계로 감지한다.

| 단계 | 감시 대상 | 실패로 세는 경우 |
|---|---|---|
| 1단계 | 태스크가 `RUNNING`에 도달하는지 | 태스크가 `RUNNING`이 되지 못하고 멈춤 |
| 2단계 | `RUNNING` 태스크가 하나라도 생긴 뒤의 헬스 체크 | ELB, Cloud Map, 컨테이너 헬스 체크 실패로 교체됨 |

실패 횟수가 임계값에 도달하면 배포 상태(`rolloutState`)가 `FAILED`가 되고 더 이상 새 태스크를 띄우지 않는다. 임계값은 `desiredCount × 0.5`를 올림한 값이며, 최소 3, 최대 200으로 제한된다. `desiredCount`가 1이면 3, 25면 13, 400이면 200이다.

`rollback`을 켜면 실패한 배포를 감지했을 때 가장 최근에 `COMPLETED` 상태였던 배포로 자동으로 되돌린다.

```bash
aws ecs update-service \
  --cluster prod \
  --service api \
  --deployment-configuration "deploymentCircuitBreaker={enable=true,rollback=true},minimumHealthyPercent=100,maximumPercent=200"
```

롤백도 결국 새 배포이므로, 롤백 대상 리비전이 참조하는 이미지가 ECR 수명 주기 정책으로 지워졌다면 롤백도 실패한다. 서킷 브레이커가 감지하는 것은 "태스크가 뜨지 못하거나 헬스 체크를 통과하지 못하는" 실패다. 태스크는 정상인데 에러율이나 지연이 올라가는 문제는 잡지 못하므로, 이런 경우는 CloudWatch 알람 기반 배포 실패 감지를 함께 쓰거나 별도 모니터링이 필요하다.

배포 결과는 `DescribeServices`의 `rolloutState`와 `rolloutStateReason`으로 확인하고, 실패 시 EventBridge로 `SERVICE_DEPLOYMENT_FAILED` 이벤트가 전송되므로 이를 알림 채널에 연결해 둔다. CI에서는 `aws ecs wait services-stable`로 안정 상태를 기다리고, 실패하면 파이프라인을 실패로 처리한다.

## 설정 값 사이의 관계

각 설정은 따로 보면 단순하지만 서로 맞물린다.

| 관계 | 어긋나면 |
|---|---|
| 헬스 체크 유예 기간 ≥ 애플리케이션 부팅 시간 | 부팅 중인 태스크가 비정상으로 판정되어 무한 재시작 |
| 등록 취소 지연 ≥ 가장 긴 요청 처리 시간 | 처리 중인 요청이 끊겨 5xx |
| 애플리케이션 종료 대기 < `stopTimeout` | 정리 도중 `SIGKILL` |
| `minimumHealthyPercent`·`maximumPercent`가 최소 1개의 교체를 허용 | 배포가 시작되지 않음 |
| 서킷 브레이커 롤백 대상 이미지가 ECR에 존재 | 롤백 실패 |

## 정리

1. `minimumHealthyPercent`(올림)와 `maximumPercent`(내림)가 한 번에 교체되는 태스크 수를 정하며, Fargate에서는 `100 / 200`이 용량을 줄이지 않는 가장 안전한 조합이다.
2. 로드 밸런서를 쓰는 서비스의 "정상"은 `RUNNING`이면서 대상 그룹 헬스 체크를 통과한 상태이고, 헬스 체크 경로는 실제 요청 처리 가능 여부를 반영해야 한다.
3. `healthCheckGracePeriodSeconds`(기본 0)로 부팅 중인 태스크가 비정상으로 판정되어 교체되는 것을 막는다.
4. 태스크 종료는 대상 그룹 등록 취소 → 등록 취소 지연 → `SIGTERM` → `stopTimeout` 후 `SIGKILL` 순서로 진행되며, 등록 취소 지연 기본값 300초는 API에 맞게 줄인다.
5. 애플리케이션은 `SIGTERM`을 직접 받아 그레이스풀 셧다운을 해야 하고, 그 대기 시간은 `stopTimeout`보다 짧아야 한다.
6. 배포 서킷 브레이커와 `rollback`을 켜서 시작하지 못하는 배포를 `FAILED`로 끝내고 마지막 `COMPLETED` 배포로 자동 복구한다.
