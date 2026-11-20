---
layout: post
title: MySQL 시간대 처리 — TIMESTAMP, DATETIME, 그리고 JDBC
date: 2022-02-14
tags: [spring-boot, infra]
description: 시간 값이 어디서 생성되고 어떤 타입에 저장되는지에 따라 시간대 해석이 달라진다.
---

시간이 9시간 어긋나는 문제는 대부분 **시간을 만드는 곳이 둘 이상**이고, 각자 다른 시간대를 기준으로 할 때 생긴다. MySQL, JDBC 드라이버, JVM이 각각 시간대를 가진다.

## MySQL의 시간대 변수

```sql
SELECT @@global.time_zone, @@session.time_zone, @@system_time_zone;
```

- `system_time_zone`: 서버가 시작할 때 호스트의 시간대를 읽어 정하는 값
- `time_zone`: 기본값 `SYSTEM`. `NOW()`, `CURRENT_TIMESTAMP`는 **세션 time_zone** 기준으로 계산된다.

RDS for MySQL은 기본 시간대가 UTC이고, 기본 파라미터 그룹은 수정할 수 없다. 시간대를 바꾸려면 사용자 파라미터 그룹을 만들어 `time_zone`을 지정해야 한다.

## TIMESTAMP와 DATETIME

| 타입 | 저장 방식 | 세션 time_zone 영향 |
|---|---|---|
| `TIMESTAMP` | UTC로 변환해 저장, 읽을 때 세션 시간대로 변환 | 받음 |
| `DATETIME` | 입력 값 그대로 저장 | 받지 않음 |

`TIMESTAMP`는 하나의 "순간"을 저장하고, `DATETIME`은 "벽시계 값"을 저장한다. `TIMESTAMP`는 범위가 `1970-01-01 00:00:01` ~ `2038-01-19 03:14:07` UTC로 제한된다(2038년 한계).

## Connector/J의 시간대 설정

Connector/J 8.0.23부터 시간대 관련 옵션이 정리됐다.

```properties
spring.datasource.url=jdbc:mysql://host:3306/db?connectionTimeZone=Asia/Seoul&forceConnectionTimeZoneToSession=true
```

- `connectionTimeZone`: 드라이버가 서버 세션 시간대를 무엇으로 간주할지(`LOCAL`, `SERVER`, 또는 지정한 시간대). 8.0.23부터 `serverTimezone`은 이 옵션의 별칭이다.
- `forceConnectionTimeZoneToSession`: 세션 `time_zone`을 위 값으로 설정할지
- `preserveInstants`: 위 두 옵션 기준으로 시간대를 변환해 순간(instant)을 보존할지. 저장 시에는 대상 타입이 `TIMESTAMP`일 때, 조회 시에는 `java.sql.Timestamp`, `OffsetDateTime` 같은 순간 기반 클래스로 읽을 때 변환한다(`false`면 변환 없이 값을 그대로 보낸다)

## Java 쪽

`LocalDateTime`은 시간대 정보가 없다. JVM 기본 시간대(`user.timezone`)로 `now()`를 계산하므로, 서버 OS가 UTC면 UTC 시각이 나온다.

```properties
spring.jpa.properties.hibernate.jdbc.time_zone=UTC
```

Hibernate의 이 설정을 지정하면 `PreparedStatement#setTimestamp`, `setTime`을 호출할 때 이 시간대의 `Calendar`를 함께 넘긴다. 지정하지 않으면 JDBC 드라이버는 JVM 기본 시간대를 쓴다.

## 권장 구성

1. **저장은 UTC로 통일**한다. DB, JDBC, JVM 시간대를 모두 UTC로 맞춘다.
2. 순간을 표현하는 값은 `Instant` 또는 `OffsetDateTime`을 쓴다.
3. 사용자에게 보여 줄 때만 지역 시간대로 변환한다.
4. 시간 생성 위치를 한 곳으로 정한다. DB 기본값(`DEFAULT CURRENT_TIMESTAMP`)과 애플리케이션 `now()`를 섞지 않는다.

이미 다른 기준으로 저장된 데이터는 `CONVERT_TZ(col, '+00:00', '+09:00')`로 이관한다. 이름 기반 시간대(`Asia/Seoul`)를 쓰려면 MySQL 시간대 테이블이 로드되어 있어야 한다. 세션 `time_zone`을 `Asia/Seoul`처럼 이름으로 지정할 때도 마찬가지다.
