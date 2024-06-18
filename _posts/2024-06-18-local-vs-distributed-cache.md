---
layout: post
title: 로컬 캐시와 분산 캐시 — 다중 인스턴스에서 캐시 일관성 맞추기
date: 2024-06-18
tags: [spring-boot]
description: 여러 인스턴스가 각자 로컬 캐시를 가질 때 생기는 불일치를 TTL, 무효화 브로드캐스트, 2단계 캐시, 커밋 후 무효화로 다루는 방법.
---

로컬 캐시는 같은 JVM 힙에 값을 두므로 네트워크 왕복이 없고 직렬화 비용도 없다. 문제는 애플리케이션이 여러 인스턴스로 실행될 때다. 인스턴스마다 캐시가 따로 있으므로, 한 인스턴스에서 데이터를 수정하고 자기 캐시를 비워도 다른 인스턴스의 캐시는 그대로 남는다. 이 글은 로컬 캐시와 분산 캐시(Distributed Cache)의 차이를 정리하고, 다중 인스턴스 환경에서 캐시와 DB를 맞추는 방법을 다룬다. 예제는 Spring Boot 2.7, Spring Data Redis 2.7 기준이다.

## 불일치가 생기는 과정

인스턴스 A, B가 로드 밸런서 뒤에 있고, 둘 다 `video:1`을 로컬 캐시에 가지고 있다고 하자.

1. 수정 요청이 A로 들어가 DB를 갱신하고 A의 캐시에서 `video:1`을 삭제한다.
2. 다음 조회 요청이 B로 들어간다. B의 캐시에는 이전 값이 남아 있으므로 그대로 반환한다.
3. 같은 사용자가 새로고침할 때마다 A와 B 중 어디로 가느냐에 따라 새 값과 이전 값이 번갈아 보인다.

`@CacheEvict`는 호출된 인스턴스의 `CacheManager`에만 작동한다. 다른 인스턴스에 알리는 기능은 로컬 캐시에 없다.

## 로컬 캐시와 분산 캐시

| 항목 | 로컬 캐시(Caffeine) | 분산 캐시(Redis) |
|---|---|---|
| 조회 지연 | 메모리 접근 수준 | 네트워크 왕복 + 역직렬화 |
| 인스턴스 간 일관성 | 인스턴스마다 다름 | 모든 인스턴스가 같은 값을 봄 |
| 용량 | 힙 크기에 제한, GC 부담 | 별도 서버 메모리 |
| 장애 영향 | 없음(프로세스와 생명주기 같음) | Redis 장애 시 모든 인스턴스에 영향 |
| 배포·재시작 | 캐시가 비워진 채 시작 | 재시작해도 유지 |

로컬 캐시만으로 충분한지는 데이터가 얼마나 낡아도 되는지로 판단한다. 코드성 데이터, 설정값, 카테고리 목록처럼 거의 바뀌지 않거나 몇십 초 늦게 반영돼도 되는 데이터는 로컬 캐시와 짧은 TTL로 충분하다. 사용자가 방금 수정한 값을 바로 다시 확인하는 화면이라면 다른 장치가 필요하다.

## 방법 1: TTL로 낡음의 상한만 정하기

가장 단순한 방법은 무효화를 포기하고 `expireAfterWrite`로 최대 낡음 시간만 보장하는 것이다. 어떤 인스턴스든 TTL이 지나면 원본에서 다시 읽는다.

- 최악의 경우 TTL 동안 이전 값이 보인다.
- TTL을 줄일수록 일관성은 좋아지지만 적중률이 떨어지고 DB 부하가 늘어난다.
- 인스턴스 수가 N이면 같은 키에 대해 TTL마다 최대 N번 원본을 읽는다.

TTL은 다른 방법을 쓸 때도 안전망으로 반드시 함께 둔다. 무효화 메시지가 유실되더라도 TTL이 지나면 결국 맞춰지기 때문이다.

## 방법 2: Redis Pub/Sub로 무효화 브로드캐스트

데이터를 수정한 인스턴스가 무효화 메시지를 발행하고, 모든 인스턴스가 구독해 자기 로컬 캐시에서 해당 키를 지운다.

```java
@Configuration
public class CacheInvalidationConfig {

    public static final String CHANNEL = "cache-invalidation";

    @Bean
    public RedisMessageListenerContainer invalidationListenerContainer(
            RedisConnectionFactory connectionFactory,
            CacheInvalidationListener listener) {
        RedisMessageListenerContainer container = new RedisMessageListenerContainer();
        container.setConnectionFactory(connectionFactory);
        container.addMessageListener(listener, new ChannelTopic(CHANNEL));
        return container;
    }
}
```

```java
@Component
public class CacheInvalidationListener implements MessageListener {

    private final CacheManager localCacheManager;

    public CacheInvalidationListener(CacheManager localCacheManager) {
        this.localCacheManager = localCacheManager;
    }

    @Override
    public void onMessage(Message message, byte[] pattern) {
        // 메시지 형식: "<cacheName>|<key>"
        String body = new String(message.getBody(), StandardCharsets.UTF_8);
        String[] parts = body.split("\\|", 2);
        Cache cache = localCacheManager.getCache(parts[0]);
        if (cache != null) {
            cache.evict(Long.valueOf(parts[1]));
        }
    }
}
```

발행은 `CacheInvalidationPublisher`라는 빈에서 `StringRedisTemplate.convertAndSend(CHANNEL, cacheName + "|" + key)`를 호출하는 것으로 충분하다. 발행한 인스턴스도 같은 채널을 구독하므로 자기 캐시도 메시지로 지워진다. 키 타입은 `@Cacheable`이 만든 키와 정확히 같아야 한다. 위 예제는 `key = "#id"`로 `Long`을 키로 쓰는 경우이므로 문자열을 `Long`으로 되돌려 `evict`한다.

Redis Pub/Sub의 전달 보장은 최대 한 번(at-most-once)이다. 발행 시점에 연결이 끊겨 있던 구독자는 그 메시지를 영영 받지 못한다. 네트워크 순단이나 재연결 중에 메시지가 유실될 수 있으므로, 앞에서 말한 TTL을 반드시 함께 둔다. 유실을 허용할 수 없다면 Redis Streams나 메시지 브로커를 쓰거나 아예 분산 캐시로 옮긴다.

## 방법 3: 2단계 캐시(L1 Caffeine + L2 Redis)

로컬 캐시를 1단계(L1), Redis를 2단계(L2)로 두고 L1 → L2 → DB 순서로 조회한다. L1 미스가 DB까지 가지 않고 Redis에서 끝나므로, 인스턴스가 늘어나도 DB 부하는 L2 기준으로 유지된다. Caffeine 문서도 이런 구성을 계층형 캐시(Layered Cache)라고 부르며, 작고 빠른 캐시가 느리고 큰 캐시로 폴백하는 구조로 설명한다.

```java
@Component
public class VideoCache {

    private final Cache<Long, VideoDto> l1 = Caffeine.newBuilder()
            .maximumSize(10_000)
            .expireAfterWrite(Duration.ofSeconds(30))
            .build();

    private final RedisTemplate<String, VideoDto> redisTemplate;
    private final VideoRepository videoRepository;
    private final CacheInvalidationPublisher publisher;

    public VideoCache(RedisTemplate<String, VideoDto> redisTemplate,
                      VideoRepository videoRepository,
                      CacheInvalidationPublisher publisher) {
        this.redisTemplate = redisTemplate;
        this.videoRepository = videoRepository;
        this.publisher = publisher;
    }

    public VideoDto get(Long id) {
        return l1.get(id, this::loadFromL2);
    }

    private VideoDto loadFromL2(Long id) {
        String key = "video:" + id;
        VideoDto cached = redisTemplate.opsForValue().get(key);
        if (cached != null) {
            return cached;
        }
        VideoDto loaded = videoRepository.findById(id).map(VideoDto::from).orElse(null);
        if (loaded != null) {
            redisTemplate.opsForValue().set(key, loaded, Duration.ofMinutes(10));
        }
        return loaded;
    }

    public void evict(Long id) {
        redisTemplate.delete("video:" + id);
        publisher.publish("video", id);
    }

    public void evictLocal(Long id) {
        l1.invalidate(id);
    }
}
```

무효화는 L2 삭제 후 L1 무효화 메시지 발행 순서로 한다. 순서를 반대로 하면 L1을 지운 직후 다른 요청이 L2의 이전 값으로 L1을 다시 채울 수 있다. L1의 TTL은 L2보다 훨씬 짧게 둔다. L1은 메시지 유실 시 낡음의 상한, L2는 DB 부하 보호가 역할이다. 이 구조를 쓸 때는 구독 리스너가 `VideoCache.evictLocal`을 호출하도록 연결한다.

## 쓰기 전략: Cache-aside와 Write-through

| 전략 | 쓰기 흐름 | 장점 | 단점 |
|---|---|---|---|
| Cache-aside | DB 갱신 후 캐시 삭제, 다음 조회 때 채움 | 단순함, 쓰이지 않는 값은 캐시에 안 올라감 | 삭제 직후 첫 조회는 미스 |
| Write-through | DB 갱신과 캐시 갱신을 동기적으로 함께 수행 | 쓰기 직후에도 적중 | 쓰기 지연 증가, 안 읽히는 값도 캐시 |
| Write-behind | 캐시만 갱신하고 DB는 나중에 비동기 반영 | 쓰기 처리량이 높음 | 장애 시 데이터 유실 가능 |

Caffeine 문서는 write-through를 "쓰기 작업이 성공한 경우에만 캐시를 갱신하는" 방식으로, write-back(write-behind)을 "캐시를 먼저 갱신하고 외부 자원 쓰기를 비동기로 수행해 처리량을 얻는 대신 불일치 위험을 지는" 방식으로 설명한다.

Spring 캐시 추상화에서 cache-aside는 `@Cacheable` + `@CacheEvict`, write-through는 `@CachePut`에 해당한다. 일반적인 조회 API에서는 cache-aside가 기본 선택이다. 수정 시 캐시에 값을 직접 넣으면, 동시에 들어온 두 수정의 캐시 쓰기 순서가 DB 커밋 순서와 달라 이전 값이 캐시에 남을 수 있기 때문이다. 삭제는 순서가 바뀌어도 결과가 같다.

## DB 커밋과 캐시 삭제의 순서

`@Transactional` 메서드에 `@CacheEvict`를 함께 붙이면 삭제 시점이 커밋 전인지 후인지가 프록시 어드바이스 순서에 달린다. `@EnableCaching`과 `@EnableTransactionManagement`의 `order` 기본값은 모두 `Ordered.LOWEST_PRECEDENCE`라 순서를 보장하지 않는다.

커밋 전에 캐시를 지우면 다음과 같은 경합이 생긴다.

1. 수정 트랜잭션이 캐시를 삭제한다. DB는 아직 커밋 전이다.
2. 다른 요청이 캐시 미스로 DB를 읽는다. 커밋 전이므로 이전 값을 읽는다.
3. 그 요청이 이전 값을 캐시에 넣는다.
4. 수정 트랜잭션이 커밋한다. 캐시에는 TTL이 끝날 때까지 이전 값이 남는다.

따라서 캐시 삭제와 무효화 메시지 발행은 커밋이 끝난 뒤에 한다. `@TransactionalEventListener`의 기본 단계가 `AFTER_COMMIT`이므로 이벤트로 분리하면 된다.

```java
@Service
public class VideoCommandService {

    private final VideoRepository videoRepository;
    private final ApplicationEventPublisher events;

    public VideoCommandService(VideoRepository videoRepository,
                               ApplicationEventPublisher events) {
        this.videoRepository = videoRepository;
        this.events = events;
    }

    @Transactional
    public void changeTitle(Long id, String title) {
        Video video = videoRepository.findById(id).orElseThrow();
        video.changeTitle(title);
        events.publishEvent(new VideoChangedEvent(id));
    }
}

@Component
public class VideoCacheEvictor {

    private final VideoCache videoCache;

    public VideoCacheEvictor(VideoCache videoCache) {
        this.videoCache = videoCache;
    }

    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    public void on(VideoChangedEvent event) {
        videoCache.evict(event.getVideoId());
    }
}
```

롤백되면 리스너가 호출되지 않으므로 불필요한 삭제도 없다. 트랜잭션 밖에서 이벤트를 발행하면 기본적으로 버려지므로, 트랜잭션 없이도 호출될 수 있다면 `fallbackExecution = true`를 지정한다. `AFTER_COMMIT` 시점에도 트랜잭션 자원이 아직 열려 있어 이 리스너 안에서 DB에 쓰면 커밋되지 않는다. 리스너에서 DB 작업이 필요하면 `REQUIRES_NEW`로 새 트랜잭션을 연다.

애노테이션 방식을 유지하고 싶다면 `TransactionAwareCacheManagerProxy`나 Redis의 `RedisCacheManager.builder(...).transactionAware()`를 쓸 수 있다. 이 데코레이터는 활성 트랜잭션이 있으면 `put`, `evict`, `clear`를 커밋 성공 후에 수행한다. 다만 `evictIfPresent`, `putIfAbsent` 같은 즉시 실행 연산은 지연되지 않는다.

커밋 후 삭제로도 모든 경합이 사라지지는 않는다. 조회 요청이 커밋 전에 이전 값을 읽고, 커밋과 캐시 삭제가 끝난 뒤에야 캐시에 쓰면 이전 값이 남는다. 발생 확률은 낮지만 0은 아니므로 TTL이 마지막 안전망이 된다.

## 방식 비교

| 방식 | 낡음의 상한 | 추가 인프라 | 구현 복잡도 | 적합한 데이터 |
|---|---|---|---|---|
| 로컬 캐시 + TTL | TTL | 없음 | 낮음 | 설정값, 코드성 데이터 |
| 로컬 캐시 + Pub/Sub 무효화 | 대부분 즉시, 유실 시 TTL | Redis | 중간 | 읽기 많고 수정 드문 데이터 |
| 분산 캐시(Redis) 단독 | 커밋 후 삭제 시 거의 즉시 | Redis | 낮음 | 일관성이 중요한 데이터 |
| 2단계 캐시(L1 + L2) | L1 TTL | Redis | 높음 | 읽기 트래픽이 매우 많은 핫 데이터 |

## 정리

1. 로컬 캐시의 `@CacheEvict`는 호출된 인스턴스에만 작동하므로, 다중 인스턴스에서는 다른 인스턴스의 캐시가 그대로 남는다.
2. 어떤 방식을 쓰든 `expireAfterWrite`로 낡음의 상한을 두고, 이것을 최종 안전망으로 삼는다.
3. Redis Pub/Sub로 무효화를 브로드캐스트할 수 있지만 전달 보장이 최대 한 번이므로 유실을 전제로 설계한다.
4. 2단계 캐시는 L2 삭제 후 L1 무효화 순서로 지우고, L1의 TTL을 L2보다 짧게 둔다.
5. 수정 시에는 캐시에 값을 넣기보다 삭제하는 cache-aside가 순서 경합에 강하다.
6. 캐시 삭제와 무효화 발행은 `@TransactionalEventListener(AFTER_COMMIT)`나 트랜잭션 인지 캐시로 커밋 이후에 수행한다.
