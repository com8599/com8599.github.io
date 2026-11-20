---
layout: post
title: 커넥션 풀 크기와 병목 위치
date: 2022-03-31
tags: [infra]
description: 풀을 키우거나 서버를 늘리는 것이 처리량을 높이지 않는 이유와 측정 방법.
---

응답이 느릴 때 흔히 앱 인스턴스를 늘리거나 커넥션 풀을 키운다. 하지만 병목이 DB라면 이 조치는 대기 위치를 앱에서 DB로 옮길 뿐이고, DB 경합이 늘어 오히려 느려질 수 있다.

## 풀은 DB 동시성의 상한이다

DB가 동시에 효율적으로 처리할 수 있는 쿼리 수는 CPU 코어와 디스크에 의해 제한된다. 그 이상으로 동시 실행하면 컨텍스트 스위칭(context switching)과 락 경합으로 개별 쿼리가 느려진다.

HikariCP 위키(About Pool Sizing)는 PostgreSQL 프로젝트가 제시한 식을 출발점으로 소개한다.

```python
connections = (core_count * 2) + effective_spindle_count
```

코어 수에는 하이퍼스레딩(hyper-threading) 스레드를 포함하지 않고, `effective_spindle_count`는 활성 데이터가 모두 캐시되면 0이다. 절대값이 아니라 "생각보다 훨씬 작다"는 감각을 주는 식이며, 실제 값은 부하 테스트로 정해야 한다.

## 인스턴스 수를 곱해야 한다

```python
total_connections = instance_count * maximum_pool_size  # DB가 받는 총 연결 수
```

인스턴스를 늘리면 DB가 받는 동시 연결도 같이 늘어난다. `max_connections`에 걸리기 전에 DB CPU가 먼저 포화되는 경우가 많다.

## 리틀의 법칙(Little's Law)으로 보는 필요량

```python
L = arrival_rate * avg_time               # 리틀의 법칙: L = λ × W
needed_connections = qps * avg_query_sec  # 필요 커넥션 수 ≈ 초당 쿼리 수 × 평균 쿼리 시간
```

정상 상태에서 시스템 안에 있는 평균 항목 수(L)는 평균 도착률(λ)과 평균 체류 시간(W)의 곱과 같다. 초당 500 쿼리, 평균 10ms라면 동시에 필요한 커넥션은 약 5개다. 풀이 50인데도 대기가 생긴다면 풀 크기가 아니라 **쿼리 시간**이 문제다.

## 어디서 기다리는지 측정하기

Spring Boot Actuator는 HikariCP의 Micrometer 지표 수집을 자동 설정한다. Prometheus로 내보낼 때의 이름은 다음과 같다.

| 지표 | 의미 |
|---|---|
| `hikaricp_connections_active` | 사용 중인 커넥션 |
| `hikaricp_connections_pending` | 커넥션을 기다리는 스레드 |
| `hikaricp_connections_acquire_seconds` | 획득 대기 시간 |
| `hikaricp_connections_usage_seconds` | 커넥션 점유 시간(≈ 트랜잭션 시간) |

`acquire`, `usage`는 타이머라서 실제로는 `_count`, `_sum`, `_max` 접미사가 붙은 시계열로 나온다.

- `pending`이 높고 DB CPU가 여유 있다 → 풀이 작거나 트랜잭션이 길다.
- `pending`이 높고 DB CPU도 높다 → 쿼리 자체가 비싸다. 실행 계획, 인덱스를 본다.
- `usage`가 길다 → 트랜잭션 안에서 외부 API 호출 같은 대기 작업을 하고 있지 않은지 본다.

## 부하 테스트

```js
// k6
import http from "k6/http";
export const options = { vus: 100, duration: "1m" };
export default () => http.get("http://localhost:8080/api/items");
```

설정을 하나씩 바꾸고 p95, 처리량, DB CPU, `pending`을 함께 기록해야 원인을 분리할 수 있다.

## 정리

1. 확장 전에 대기 위치를 측정한다.
2. 풀 크기는 DB가 감당할 동시성에 맞춘다. 인스턴스 수를 곱해서 계산한다.
3. 쿼리 시간을 줄이는 것(인덱스, 캐시, 트랜잭션 범위 축소)이 풀을 키우는 것보다 효과가 크다.
