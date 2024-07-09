---
layout: post
title: 캐시 스탬피드(Cache Stampede) 막기 — refreshAfterWrite와 요청 병합
date: 2024-07-09
tags: [spring-boot]
description: 인기 캐시 항목이 만료될 때 요청이 원본으로 몰리는 현상을 요청 병합, 비동기 갱신, TTL 지터, 확률적 조기 만료, 분산 락으로 완화하는 방법.
---

캐시 스탬피드(Cache Stampede)는 자주 조회되는 캐시 항목이 만료되는 순간, 동시에 들어온 여러 요청이 모두 캐시 미스를 보고 같은 값을 동시에 다시 계산하는 현상이다. 도그파일(Dog-piling), 썬더링 허드(Thundering Herd)라고도 부른다. 캐시를 둔 이유가 원본이 비싸기 때문이므로, 만료 순간 원본에 같은 쿼리가 수십 개 몰리면 원본이 느려지고, 느려진 만큼 더 많은 요청이 미스를 보는 연쇄 장애로 번질 수 있다.

## 스탬피드의 크기

전형적인 cache-aside 조회는 "캐시 확인 → 없으면 계산 → 저장"이다. 이 패턴에서 스탬피드에 참여하는 요청 수는 요청률과 재계산 시간의 곱에 비례한다. Vattani 등의 논문이 드는 예로, 초당 10번 조회되는 항목의 재계산에 3초가 걸리면 30개의 요청이 같은 값을 재계산한다.

여기에 다중 인스턴스가 겹치면 인스턴스 수만큼 배가 된다. 또 같은 시각에 일괄로 채운 캐시들은 같은 시각에 만료되므로, 여러 키의 스탬피드가 한꺼번에 일어난다.

대응 방법은 크게 세 갈래다.

| 접근 | 원리 |
|---|---|
| 요청 병합(Request Coalescing) | 같은 키의 동시 미스 중 하나만 계산하고 나머지는 결과를 기다림 |
| 만료 전 갱신 | 만료되기 전에 미리 새 값을 계산해 미스 자체를 없앰 |
| 만료 시각 분산 | 여러 키의 만료가 한 시점에 겹치지 않게 흩뜨림 |

## 요청 병합: Caffeine의 키 단위 원자적 계산

Caffeine의 `Cache.get(key, mappingFunction)`과 `LoadingCache.get(key)`는 계산 전체를 키 단위로 원자적으로 수행한다. 공식 Javadoc은 "함수는 키당 최대 한 번 적용되며", 다른 스레드가 같은 키를 로딩 중이면 "그 스레드가 끝나기를 기다렸다가 로딩된 값을 반환한다"고 명시한다. 서로 다른 키는 동시에 로딩된다.

```java
LoadingCache<Long, VideoDto> videos = Caffeine.newBuilder()
        .maximumSize(10_000)
        .expireAfterWrite(Duration.ofMinutes(5))
        .build(id -> videoRepository.findById(id).map(VideoDto::from).orElse(null));

VideoDto dto = videos.get(42L);
```

반대로 `getIfPresent`로 확인하고 없으면 직접 계산해 `put`하는 코드는 이 보장이 없다. 두 호출 사이에 다른 스레드가 끼어들기 때문이다.

계산 중에는 같은 키에 대한 다른 쓰기 연산이 막힐 수 있으므로 로딩 함수는 짧아야 하고, 로딩 함수 안에서 같은 캐시의 다른 항목을 수정하면 안 된다.

## @Cacheable(sync = true)

Spring 캐시 추상화는 기본적으로 아무것도 잠그지 않는다. 공식 문서는 같은 인자로 동시에 호출되면 "같은 값이 여러 번 계산될 수 있다"고 설명한다. `sync = true`를 지정하면 캐시 구현체에 항목을 잠그도록 요청한다.

```java
@Cacheable(cacheNames = "video", key = "#id", sync = true)
public VideoDto getVideo(Long id) {
    return videoRepository.findById(id).map(VideoDto::from).orElseThrow();
}
```

`sync = true`에는 제약이 있다.

- `unless`를 쓸 수 없다.
- 캐시를 하나만 지정할 수 있다.
- 다른 캐시 애노테이션과 함께 쓸 수 없다.
- Javadoc 표현으로 "사실상 힌트"이며, 실제 동기화 방식은 구현체마다 다르다.

구현체별 실제 동작은 다음과 같다.

| CacheManager | `sync = true`일 때 |
|---|---|
| `CaffeineCacheManager` | Caffeine의 `cache.get(key, function)` 호출, 키 단위로 한 번만 계산 |
| `RedisCacheManager`(Spring Data Redis 2.7) | 미스이면 `RedisCache` 인스턴스의 `synchronized` 메서드로 계산 |

Caffeine은 JVM 안에서 정확히 키 단위 병합이 된다. Redis 쪽은 잠금이 JVM 안의 `synchronized`이므로 인스턴스 간에는 병합되지 않고, 한 인스턴스 안에서는 키가 아니라 캐시 단위로 직렬화된다. 서로 다른 키의 미스도 같은 캐시라면 한 줄로 기다린다.

## refreshAfterWrite: 만료 전에 비동기로 갱신

요청 병합은 원본 호출 수를 1로 줄여 주지만, 기다리는 요청들은 재계산 시간만큼 지연된다. `refreshAfterWrite`는 미스를 아예 만들지 않는 방식이다.

```java
LoadingCache<Long, VideoDto> videos = Caffeine.newBuilder()
        .maximumSize(10_000)
        .refreshAfterWrite(Duration.ofMinutes(1))
        .expireAfterWrite(Duration.ofMinutes(10))
        .executor(refreshExecutor)
        .build(id -> videoRepository.findById(id).map(VideoDto::from).orElse(null));
```

동작은 Caffeine 문서와 Javadoc에 다음과 같이 정의되어 있다.

- 기록 후 1분이 지나면 항목이 갱신 대상이 된다. 타이머로 갱신하지 않고, 그 뒤 첫 조회가 들어올 때 갱신이 시작된다.
- 갱신을 일으킨 요청은 `CacheLoader.reload`를 비동기로 호출하고 **이전 값을 즉시 반환**한다.
- 갱신이 진행되는 동안의 다른 조회도 이전 값을 받는다. 같은 키의 갱신은 중복 실행되지 않는다.
- 갱신 중 예외가 나면 로그만 남기고 이전 값을 유지한다.
- 기본 실행기는 `ForkJoinPool.commonPool()`이며 `executor(...)`로 바꿀 수 있다.

`expireAfterWrite`와 함께 쓰는 이유는, 1분 이후 한 번도 조회되지 않은 항목은 갱신되지 않고 10분이 지나 만료되게 하기 위해서다. 조회가 끊긴 항목을 계속 갱신하지 않는다.

`refreshAfterWrite`는 `LoadingCache`에서만 쓸 수 있다. 로더 없이 `build()`를 호출하면 `IllegalStateException`("refreshAfterWrite requires a LoadingCache")이 발생한다. Spring Boot에서 `spring.cache.caffeine.spec`에 `refreshAfterWrite`를 넣으려면 `CacheLoader<Object, Object>` 빈을 정의해야 하며, 이 로더는 매니저의 모든 캐시에 공통으로 연결된다. 캐시마다 로딩 로직이 다르다면 Spring 캐시 추상화를 거치지 않고 위처럼 `LoadingCache`를 직접 빈으로 두는 편이 명확하다.

## TTL 지터

같은 시점에 대량으로 채운 키들은 같은 시점에 만료된다. 배포 직후 워밍업이나 배치로 채운 캐시가 대표적이다. 만료 시간에 무작위 편차(Jitter)를 더해 만료를 흩뜨린다.

```java
Duration ttlWithJitter(Duration base) {
    long jitterMillis = ThreadLocalRandom.current().nextLong(base.toMillis() / 10);
    return base.plusMillis(jitterMillis);
}

redisTemplate.opsForValue().set("video:" + id, dto, ttlWithJitter(Duration.ofMinutes(10)));
```

Caffeine은 `expireAfter(Expiry)`로 항목별 만료 시간을 줄 수 있다. 지터는 여러 키가 동시에 만료되는 문제를 줄일 뿐, 인기 키 하나의 스탬피드는 막지 못한다.

## 확률적 조기 만료: XFetch

Vattani, Chierichetti, Lowenstein의 논문 「Optimal Probabilistic Cache Stampede Prevention」(PVLDB Vol. 8, No. 8, 2015)은 각 요청이 만료 전에 확률적으로 재계산을 시작하는 방법을 분석하고, 지수 분포를 쓰는 XFetch 알고리즘을 제안한다. 논문의 의사 코드는 다음과 같다.

```text
function XFetch(key, ttl, beta = 1)
    value, delta, expiry <- CacheRead(key)
    if !value or Time() - delta * beta * log(rand()) >= expiry then
        start <- Time()
        value <- RecomputeValue()
        delta <- Time() - start
        CacheWrite(key, (value, delta), ttl)
    end
    return value
end
```

- `delta`는 지난번 재계산에 걸린 시간이다. 재계산이 오래 걸리는 항목일수록 더 일찍 갱신을 시작한다.
- `rand()`는 0과 1 사이 값이므로 `log(rand())`는 음수이고, `-delta * beta * log(rand())`는 0 이상의 무작위 앞당김 시간이 된다.
- 만료가 가까울수록 조건을 만족할 확률이 커진다. 요청이 많을수록 누군가 일찍 갱신할 가능성이 높아지므로 별도 조정 없이 동작한다.
- 논문은 `beta` 기본값 1로 충분한 효과가 있고, 더 일찍 만료되어도 괜찮다면 `beta`를 키울 수 있다고 설명한다.

```java
public <T> T xfetch(String key, Duration ttl, Supplier<T> loader) {
    CachedValue<T> cached = redisCache.get(key);
    long now = System.currentTimeMillis();
    if (cached == null
            || now - cached.getDeltaMillis() * BETA * Math.log(ThreadLocalRandom.current().nextDouble())
               >= cached.getExpiryMillis()) {
        long start = System.currentTimeMillis();
        T value = loader.get();
        long delta = System.currentTimeMillis() - start;
        redisCache.put(key, new CachedValue<>(value, delta, now + ttl.toMillis()), ttl);
        return value;
    }
    return cached.getValue();
}
```

값과 함께 `delta`와 만료 시각을 저장해야 하므로 Spring의 `@Cacheable`로는 표현하기 어렵고, 위처럼 직접 구현한다. 락이 없으므로 조기 갱신이 드물게 여러 요청에서 겹칠 수 있지만, 그 수는 만료 시점 스탬피드보다 훨씬 작다.

## 분산 락

여러 인스턴스가 Redis를 공유할 때, 재계산 권한을 하나의 요청에만 주려면 Redis 락을 쓴다. Redis 공식 문서의 `SET` 패턴은 `SET key token NX PX ttl`로 잠그고, 해제할 때는 토큰이 일치할 때만 삭제하는 스크립트를 쓰라고 안내한다. 만료 후 다른 클라이언트가 잡은 락을 지우는 실수를 막기 위해서다.

```java
private static final DefaultRedisScript<Long> UNLOCK = new DefaultRedisScript<>(
        "if redis.call('get', KEYS[1]) == ARGV[1] then "
      + "return redis.call('del', KEYS[1]) else return 0 end", Long.class);

public VideoDto getWithLock(Long id) {
    String key = "video:" + id;
    VideoDto cached = valueOps.get(key);
    if (cached != null) {
        return cached;
    }
    String lockKey = "lock:" + key;
    String token = UUID.randomUUID().toString();
    Boolean locked = stringRedisTemplate.opsForValue()
            .setIfAbsent(lockKey, token, Duration.ofSeconds(5));
    if (Boolean.TRUE.equals(locked)) {
        try {
            VideoDto loaded = loadFromDb(id);
            valueOps.set(key, loaded, Duration.ofMinutes(10));
            return loaded;
        } finally {
            stringRedisTemplate.execute(UNLOCK, List.of(lockKey), token);
        }
    }
    sleepBriefly();
    VideoDto retried = valueOps.get(key);
    return retried != null ? retried : loadFromDb(id);
}
```

락을 못 잡은 요청의 처리 방식이 설계의 핵심이다. 잠시 기다렸다 재조회, 이전 값 반환, 원본 직접 조회 중에서 고른다. 위 예제는 재조회에도 실패하면 원본을 직접 읽어 응답 지연의 상한을 둔다. 락 TTL은 재계산 시간보다 충분히 길어야 하며, 계산이 TTL보다 길어지면 두 요청이 동시에 계산할 수 있다. Redis 문서는 이 단일 인스턴스 패턴보다 Redlock을 권장하지만, 스탬피드 방지처럼 락이 가끔 겹쳐도 정합성이 깨지지 않는 용도에는 단순한 패턴으로 충분한 경우가 많다.

## 방식 비교

| 방식 | 막는 것 | 범위 | 응답 지연 | 낡은 값 반환 | 구현 비용 |
|---|---|---|---|---|---|
| Caffeine `get(key, fn)` / `sync = true` | 같은 키 동시 미스 | 인스턴스 내부 | 첫 요청 계산 시간만큼 대기 | 없음 | 낮음 |
| `refreshAfterWrite` | 만료 시점 미스 자체 | 인스턴스 내부 | 거의 없음 | 갱신 완료 전까지 | 낮음 |
| TTL 지터 | 여러 키의 동시 만료 | 전체 | 영향 없음 | 없음 | 매우 낮음 |
| XFetch | 인기 키 만료 시점 미스 | 전체(공유 캐시) | 거의 없음 | 없음 | 중간 |
| Redis 분산 락 | 인스턴스 간 동시 재계산 | 전체 | 락 대기 시간 | 선택에 따라 | 높음 |

로컬 캐시라면 `refreshAfterWrite`와 키 단위 원자적 로딩으로 대부분 해결된다. 인스턴스 수만큼의 중복 계산까지 줄여야 할 때 공유 캐시에 XFetch나 분산 락을 더한다.

## 정리

1. 캐시 스탬피드는 인기 항목 만료 시 동시 미스가 원본에 몰리는 현상이며, 규모는 요청률과 재계산 시간의 곱에 비례한다.
2. Caffeine의 `get(key, function)`과 `LoadingCache`는 키 단위로 한 번만 계산하고 나머지 요청은 결과를 기다린다.
3. `@Cacheable(sync = true)`는 구현체에 맡기는 힌트이며, Caffeine에서는 키 단위 병합, Spring Data Redis 2.7에서는 인스턴스 내 캐시 단위 `synchronized`로 동작한다.
4. `refreshAfterWrite`는 첫 조회 시 비동기 갱신을 시작하고 이전 값을 바로 반환하며, `LoadingCache`가 필요하다.
5. TTL 지터는 여러 키의 동시 만료를 흩뜨리고, XFetch는 재계산 시간에 비례해 확률적으로 미리 갱신한다.
6. 인스턴스 간 중복 계산까지 막아야 하면 토큰 기반 Redis 락을 쓰고, 락을 못 잡은 요청의 처리 방식을 명확히 정한다.
