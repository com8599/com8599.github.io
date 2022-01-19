---
layout: post
title: CodeDeploy 라이프사이클 훅과 배포 검증
date: 2022-01-19
tags: [infra, spring-boot]
description: appspec 훅의 실행 순서, 종료 코드의 의미, 그리고 "배포 성공"을 실제 기동 성공으로 만드는 방법.
---

로드밸런서를 연결하지 않은 EC2 In-place 배포에서 인스턴스 단위의 성공/실패는 **훅 스크립트의 종료 코드**(와 timeout 초과 여부)로 결정된다. 애플리케이션이 실제로 떴는지는 CodeDeploy가 알지 못한다. 그래서 스크립트를 어떻게 짜느냐가 곧 배포 검증의 수준이 된다.

## EC2 In-place 배포의 훅 순서

```yaml
# 실행 순서
- ApplicationStop
- DownloadBundle    # 스크립트 불가
- BeforeInstall
- Install           # 스크립트 불가
- AfterInstall
- ApplicationStart
- ValidateService
```

- `DownloadBundle`, `Install`은 에이전트가 직접 수행하며 스크립트를 걸 수 없다. (`Install`에서 복사할 파일은 appspec의 `files` 섹션으로 지정한다.)
- 배포 그룹에 로드밸런서를 지정하면 `ApplicationStop` 앞에 `BeforeBlockTraffic → BlockTraffic → AfterBlockTraffic`이, `ValidateService` 뒤에 `BeforeAllowTraffic → AllowTraffic → AfterAllowTraffic`이 추가된다. `BlockTraffic`, `AllowTraffic`도 스크립트를 걸 수 없다.
- `ApplicationStop`(로드밸런서가 있으면 `BeforeBlockTraffic`, `AfterBlockTraffic`도)은 **마지막으로 성공한 리비전(revision)**의 appspec과 스크립트를 실행한다. 인스턴스에 appspec이 아직 없는 첫 배포에는 `ApplicationStop`이 실행되지 않고, 이전 리비전 스크립트가 깨져 있으면 새 배포도 실패한다. 이때는 배포 생성 시 `--ignore-application-stop-failures` 옵션으로 이 세 이벤트의 실패를 무시하고 넘길 수 있다.
- 각 스크립트는 `timeout`(초, 기본 3600)을 넘기면 실패로 처리된다. 한 라이프사이클 이벤트에 속한 스크립트의 timeout 합계는 3600초를 넘지 않아야 한다.

```yaml
version: 0.0
os: linux
files:
  - source: /
    destination: /home/ec2-user/app
hooks:
  ApplicationStop:
    - location: scripts/stop.sh
      timeout: 60
  ApplicationStart:
    - location: scripts/start.sh
      timeout: 60
  ValidateService:
    - location: scripts/validate.sh
      timeout: 120
```

## 백그라운드 실행과 종료 코드

```bash
nohup java -jar app.jar &
```

`&`로 넘기면 스크립트 자체는 곧바로 0으로 끝난다. 이후 JVM이 포트 충돌로 죽어도 해당 훅은 성공으로 기록된다.

또 하나의 함정은 표준 입출력이다. 백그라운드 프로세스가 stdout/stderr/stdin을 물고 있으면 에이전트가 훅이 끝난 것으로 보지 않아, 배포가 timeout(기본 1시간)까지 대기하다 실패할 수 있다. `nohup`은 표준 출력이 터미널일 때만 `nohup.out`으로 돌리므로 에이전트 아래에서는 이 문제를 막아 주지 않는다. AWS 문서의 권고대로 stdout, stderr, stdin을 모두 리다이렉트한다.

```bash
# start.sh
nohup java -jar /home/ec2-user/app/app.jar > /home/ec2-user/app/app.log 2>&1 < /dev/null &
echo $! > /home/ec2-user/app/app.pid
```

## 종료: pid 파일과 graceful shutdown

```bash
# stop.sh
PID_FILE=/home/ec2-user/app/app.pid
[ -f "$PID_FILE" ] || exit 0
PID=$(cat "$PID_FILE")
kill -15 "$PID" 2>/dev/null || exit 0
for i in $(seq 1 30); do
  kill -0 "$PID" 2>/dev/null || exit 0
  sleep 1
done
kill -9 "$PID"
```

`SIGTERM`을 먼저 보내야 Spring Boot가 종료 훅을 실행한다. Boot 2.3부터는 처리 중인 요청을 마치고 내려가도록 설정할 수 있다(2.x의 기본값은 `immediate`, 대기 시간 기본값은 30초). Boot 3.4부터는 graceful이 기본값이다. 대기 시간은 stop.sh가 `SIGKILL`을 보내기 전 대기 시간보다 짧게 잡는다.

```properties
server.shutdown=graceful
spring.lifecycle.timeout-per-shutdown-phase=20s
```

## ValidateService: 성공의 정의를 바꾸기

```bash
# validate.sh
for i in $(seq 1 20); do
  STATUS=$(curl -s --max-time 2 -o /dev/null -w "%{http_code}" http://localhost:8080/actuator/health)
  [ "$STATUS" = "200" ] && exit 0
  sleep 3
done
exit 1
```

이 훅이 있어야 "스크립트가 끝났다"가 아니라 "애플리케이션이 응답한다"가 배포 성공의 조건이 된다. `/actuator/health`는 `spring-boot-starter-actuator`가 있어야 노출되며, 기본 매핑에서 상태가 `UP`이면 200, `DOWN`이나 `OUT_OF_SERVICE`면 503을 돌려준다. 배포 그룹에 "배포 실패 시 롤백"을 켜 두면 실패 시 마지막으로 성공한 리비전이 새 배포 ID로 다시 배포된다.

## 정리

| 항목 | 역할 |
|---|---|
| 종료 코드 | 훅 성공/실패의 기준 (timeout 초과도 실패) |
| 출력 리다이렉트 | 백그라운드 프로세스로 인한 훅 멈춤 방지 |
| pid + SIGTERM | 이전 프로세스 확실한 종료, graceful shutdown |
| ValidateService | 실제 기동 여부를 배포 결과에 반영 |
