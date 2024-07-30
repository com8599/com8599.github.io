---
layout: post
title: 조회수 집계 — 쓰기 버퍼링(Write-behind)과 배치 업데이트
date: 2024-07-30
tags: [spring-boot]
description: 조회마다 UPDATE하는 방식의 행 락 경합을 메모리·Redis 버퍼링과 주기적 배치 업데이트로 줄이고, 유실 구간과 종료 처리까지 정리한다.
---

조회수는 읽힐 때마다 쓰기가 일어나는 특이한 데이터다. 가장 단순한 구현은 조회 요청마다 `UPDATE video SET view_count = view_count + 1 WHERE id = ?`를 실행하는 것이다. 트래픽이 적을 때는 문제가 없지만, 인기 콘텐츠 하나에 조회가 몰리면 같은 행에 대한 쓰기가 줄을 서게 된다. 이 글은 조회수 증가분을 모아 두었다가 주기적으로 한 번에 반영하는 쓰기 버퍼링(Write-behind)을 Spring Boot 2.7과 MySQL(InnoDB) 기준으로 다룬다.

## 핫 로우(Hot Row) 락 경합

InnoDB에서 `UPDATE ... WHERE`는 검색 중 만나는 레코드에 배타적 락을 건다. 고유 인덱스로 단일 행을 찾는 경우에는 그 인덱스 레코드 락만 필요하다. 기본 키로 한 행을 갱신하는 조회수 UPDATE는 그 행 하나에 배타 락을 걸고, 이 락은 트랜잭션이 커밋될 때까지 유지된다.

같은 영상에 동시에 100건의 조회가 들어오면 100개의 트랜잭션이 같은 행의 락을 순서대로 기다린다.

- 각 UPDATE는 락 대기 + 쓰기 + 커밋(redo 로그 플러시) 시간을 차례로 소비한다.
- 조회수 UPDATE가 영상 정보 수정 같은 다른 트랜잭션과 같은 행을 두고 경합한다.
- 조회 API 트랜잭션 안에서 UPDATE를 하면 락을 잡은 채로 나머지 로직을 수행하므로 대기 시간이 더 길어진다.
- 락 대기가 `innodb_lock_wait_timeout`을 넘으면 오류가 난다.

조회수는 정확한 실시간 값이 필요하지 않은 경우가 대부분이다. 몇 초 늦게 반영되어도 되고, 장애 시 수 초 분량이 빠져도 서비스에 치명적이지 않다. 이 성질을 이용해 쓰기를 모은다.

## 쓰기 버퍼링의 원리

1. 조회 요청은 DB 대신 메모리나 Redis의 카운터만 증가시킨다.
2. 스케줄러가 몇 초마다 쌓인 증가분을 꺼낸다.
3. `UPDATE ... SET view_count = view_count + ?`를 영상별로 한 번씩, 배치로 실행한다.

인기 영상에 1초 동안 1,000건의 조회가 들어와도 DB에는 `+1000` UPDATE 한 건만 간다. 행 락은 플러시할 때 짧게 한 번만 잡힌다. Caffeine 문서도 write-back 캐시의 기능으로 연산의 일괄 처리와 병합, 시간 창 단위 지연, 주기적 플러시를 꼽는다.

증가분을 더하는 방식(`view_count + ?`)을 쓰는 이유는, 여러 인스턴스가 각자 버퍼를 플러시해도 결과가 합산되기 때문이다. 절대값을 덮어쓰면 인스턴스끼리 값을 덮어쓴다.

## 방법 1: JVM 메모리 버퍼

```java
@Component
public class ViewCountBuffer {

    private final ConcurrentHashMap<Long, Long> pending = new ConcurrentHashMap<>();

    public void increment(Long videoId) {
        pending.merge(videoId, 1L, Long::sum);
    }

    public Map<Long, Long> drain() {
        Map<Long, Long> snapshot = new HashMap<>();
        for (Long videoId : pending.keySet()) {
            Long count = pending.remove(videoId);
            if (count != null) {
                snapshot.put(videoId, count);
            }
        }
        return snapshot;
    }
}
```

`ConcurrentHashMap.merge`와 `remove`는 각각 키 단위로 원자적이다. 증가와 꺼내기가 동시에 일어나도 증가분은 이번 스냅샷이나 다음 스냅샷 중 한 곳에만 들어가므로 유실이나 중복이 없다.

`ConcurrentHashMap<Long, LongAdder>`에 `computeIfAbsent(id, k -> new LongAdder()).increment()`를 쓰면 같은 키에 대한 증가 경합은 더 줄어든다. 하지만 `increment()`가 맵의 원자적 연산 밖에서 실행되므로, 플러시가 `remove`로 항목을 꺼낸 직후 이미 그 `LongAdder` 참조를 얻은 스레드가 증가시키면 그 값은 버려진다. `LongAdder.sumThenReset()`도 Javadoc에 따르면 동시 갱신이 있을 때 반환값이 리셋 직전의 최종값이라고 보장하지 않는다. 버퍼링으로 DB 락 경합이 사라진 뒤에는 메모리 맵의 키 단위 잠금 비용은 상대적으로 작으므로, 정확성이 보장되는 `merge` 방식을 기본으로 쓴다.

## 주기적 플러시와 배치 UPDATE

```java
@Component
public class ViewCountFlusher {

    private static final String SQL =
            "UPDATE video SET view_count = view_count + ? WHERE id = ?";

    private final ViewCountBuffer buffer;
    private final JdbcTemplate jdbcTemplate;

    public ViewCountFlusher(ViewCountBuffer buffer, JdbcTemplate jdbcTemplate) {
        this.buffer = buffer;
        this.jdbcTemplate = jdbcTemplate;
    }

    @Scheduled(fixedDelay = 5000)
    public void flush() {
        Map<Long, Long> snapshot = buffer.drain();
        if (snapshot.isEmpty()) {
            return;
        }
        List<Object[]> args = snapshot.entrySet().stream()
                .sorted(Map.Entry.comparingByKey())
                .map(e -> new Object[] {e.getValue(), e.getKey()})
                .collect(Collectors.toList());
        jdbcTemplate.batchUpdate(SQL, args);
    }
}
```

```java
@SpringBootApplication
@EnableScheduling
public class Application {
    public static void main(String[] args) {
        SpringApplication.run(Application.class, args);
    }
}
```

- `fixedDelay`는 이전 실행이 끝난 뒤부터 간격을 잰다. 플러시가 길어져도 겹쳐 실행되지 않는다.
- Boot가 자동 구성하는 스케줄러의 스레드 수(`spring.task.scheduling.pool.size`) 기본값은 1이다. 다른 `@Scheduled` 작업이 오래 걸리면 플러시가 밀리므로 필요하면 늘린다.
- id 순으로 정렬하면 여러 인스턴스가 동시에 플러시할 때 행 락을 같은 순서로 잡으므로 교착 상태(Deadlock) 가능성을 줄인다.
- `batchUpdate`는 JDBC 배치로 문장을 묶어 보낸다. MySQL Connector/J는 `rewriteBatchedStatements=true`일 때 INSERT·REPLACE는 다중 VALUES로 재작성하고 그 밖의 문장은 다중 쿼리로 묶어 전송하므로, 네트워크 왕복이 줄어든다. 기본값은 `false`다.

```properties
spring.datasource.url=jdbc:mysql://db:3306/app?rewriteBatchedStatements=true
```

플러시 중 DB 오류가 나면 꺼낸 스냅샷이 사라진다. 실패 시 `snapshot`의 값을 다시 `merge`로 버퍼에 되돌려 다음 주기에 재시도하게 한다.

```java
try {
    transactionTemplate.executeWithoutResult(status -> jdbcTemplate.batchUpdate(SQL, args));
} catch (DataAccessException e) {
    snapshot.forEach((id, count) -> buffer.restore(id, count));
    throw e;
}
```

`restore`는 `pending.merge(id, count, Long::sum)`이다. 배치가 일부만 반영된 뒤 실패한 상태에서 되돌리면 중복 반영되므로, `TransactionTemplate`으로 배치 전체를 하나의 트랜잭션으로 묶어 전부 성공하거나 전부 롤백되게 한다. 같은 클래스 안에서 호출되는 메서드라 `@Transactional`은 프록시를 거치지 않으므로 프로그래밍 방식 트랜잭션을 쓴다.

## 유실 구간과 종료 시 플러시

메모리 버퍼의 가장 큰 약점은 프로세스가 죽으면 아직 플러시하지 않은 증가분이 사라진다는 것이다. 최대 유실량은 플러시 주기 동안의 조회수다.

정상 종료라면 마지막으로 한 번 더 플러시해 유실을 없앨 수 있다.

```java
@PreDestroy
public void flushOnShutdown() {
    flush();
}
```

```yaml
server:
  shutdown: graceful
spring:
  lifecycle:
    timeout-per-shutdown-phase: 20s
```

`server.shutdown=graceful`이면 애플리케이션 컨텍스트를 닫는 첫 단계에서 웹 서버가 새 요청을 받지 않고 진행 중인 요청이 끝나기를 기다린다. 대기 시간은 `spring.lifecycle.timeout-per-shutdown-phase`(기본 30초)로 정한다. 요청이 모두 끝난 뒤 빈이 소멸되면서 `@PreDestroy`가 실행되므로, 마지막 요청의 증가분까지 플러시된다. `@PreDestroy` 시점에는 이 빈이 의존하는 `JdbcTemplate`과 `DataSource`가 아직 살아 있다.

컨테이너 환경에서는 오케스트레이터가 SIGTERM을 보낸 뒤 정해진 유예 시간이 지나면 SIGKILL로 강제 종료한다. 유예 시간은 graceful shutdown 대기와 마지막 플러시를 합친 시간보다 길어야 한다. SIGKILL, OOM, 호스트 장애처럼 비정상 종료에서는 여전히 플러시 주기만큼 유실된다.

## 방법 2: Redis 버퍼

증가분을 Redis에 쌓으면 애플리케이션 재시작이나 장애에도 버퍼가 유지되고, 여러 인스턴스가 하나의 버퍼를 공유한다. `HINCRBY`는 해시의 필드 값을 원자적으로 증가시키며, 키나 필드가 없으면 0에서 시작한다.

```java
public void increment(Long videoId) {
    redisTemplate.opsForHash().increment("views:pending", videoId.toString(), 1);
}
```

플러시할 때는 읽는 도중 들어오는 증가분과 섞이지 않도록 `RENAME`으로 해시를 통째로 다른 키로 옮긴 뒤 읽는다. 새 증가분은 다시 만들어지는 `views:pending`에 쌓인다.

```java
@Scheduled(fixedDelay = 5000)
public void flushFromRedis() {
    String processing = "views:processing";
    if (Boolean.FALSE.equals(redisTemplate.hasKey(processing))) {
        if (Boolean.FALSE.equals(redisTemplate.hasKey("views:pending"))) {
            return;
        }
        redisTemplate.rename("views:pending", processing);
    }
    Map<Object, Object> entries = redisTemplate.opsForHash().entries(processing);
    List<Object[]> args = entries.entrySet().stream()
            .map(e -> new Object[] {Long.valueOf(e.getValue().toString()),
                                    Long.valueOf(e.getKey().toString())})
            .sorted(Comparator.comparing(a -> (Long) a[1]))
            .collect(Collectors.toList());
    transactionTemplate.executeWithoutResult(status -> jdbcTemplate.batchUpdate(SQL, args));
    redisTemplate.delete(processing);
}
```

- `views:processing`이 이미 있으면 지난번 플러시가 DB 반영 후 삭제 전에 실패한 것이므로 그것부터 처리한다.
- 여러 인스턴스가 같은 작업을 실행하면 안 되므로, 플러시는 한 인스턴스에서만 실행되게 분산 락이나 ShedLock 같은 도구로 막는다.
- DB 커밋 후 `DELETE` 전에 죽으면 다음 플러시에서 같은 값이 다시 더해진다. 즉 이 방식은 최소 한 번(at-least-once) 반영이다. 정확히 한 번이 필요하면 반영 이력을 따로 기록해야 한다.
- Redis 클러스터에서는 `RENAME`의 두 키가 같은 해시 슬롯에 있어야 하므로 `{views}:pending`처럼 해시 태그(Hash Tag)를 쓴다.

Redis의 내구성은 영속화 설정(RDB, AOF)에 달려 있으므로, Redis 버퍼도 Redis 장애 시 일부 유실이 있을 수 있다.

## 사용자별 중복 조회 제거

같은 사용자가 새로고침할 때마다 조회수가 오르는 것을 막으려면 일정 시간 안의 재조회를 걸러 낸다. 사용자와 영상 조합으로 키를 만들고 `SET NX`와 TTL을 쓴다.

```java
public void recordView(Long videoId, Long userId) {
    String dedupKey = "viewed:" + videoId + ":" + userId;
    Boolean first = stringRedisTemplate.opsForValue()
            .setIfAbsent(dedupKey, "1", Duration.ofMinutes(30));
    if (Boolean.TRUE.equals(first)) {
        viewCountBuffer.increment(videoId);
    }
}
```

키가 조회 건수만큼 생기므로 메모리 사용량을 계산해 TTL을 정한다. 대략적인 고유 사용자 수만 필요하다면 HyperLogLog(`PFADD`, `PFCOUNT`)처럼 근사 구조를 쓰는 방법도 있다.

## 방식 비교

| 방식 | DB 쓰기 | 행 락 경합 | 반영 지연 | 유실 위험 | 추가 인프라 |
|---|---|---|---|---|---|
| 조회마다 UPDATE | 조회 수만큼 | 높음 | 즉시 | 없음 | 없음 |
| JVM 메모리 버퍼 + 배치 | 주기당 영상 수만큼 | 낮음 | 플러시 주기 | 비정상 종료 시 한 주기분 | 없음 |
| Redis 버퍼 + 배치 | 주기당 영상 수만큼 | 낮음 | 플러시 주기 | Redis 영속화 설정에 따름 | Redis |
| Redis를 원본으로, DB는 보조 | 주기적 동기화 | 없음 | 즉시(Redis 기준) | Redis 영속화 설정에 따름 | Redis |

## 정리

1. 조회마다 `view_count + 1`을 실행하면 InnoDB가 같은 행에 배타 락을 걸어 인기 콘텐츠에서 쓰기가 직렬화된다.
2. 증가분을 버퍼에 모았다가 `view_count + ?`로 주기적으로 반영하면 영상당 한 번의 UPDATE로 줄어든다.
3. JVM 버퍼는 `ConcurrentHashMap.merge`와 `remove`의 키 단위 원자성으로 유실 없이 꺼낸다.
4. 플러시는 `@Scheduled(fixedDelay)`와 `JdbcTemplate.batchUpdate`로 하고, MySQL에서는 `rewriteBatchedStatements=true`를 함께 쓴다.
5. 정상 종료는 graceful shutdown과 `@PreDestroy` 플러시로 유실을 막고, 비정상 종료 시 한 주기분 유실을 감수한다.
6. Redis 버퍼는 `HINCRBY`로 쌓고 `RENAME`으로 꺼내며, 재시도 시 중복 반영될 수 있는 최소 한 번 방식임을 전제로 한다.
