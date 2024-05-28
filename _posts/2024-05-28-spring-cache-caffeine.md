---
layout: post
title: Spring Cache 추상화와 Caffeine 로컬 캐시
date: 2024-05-28
tags: [spring-boot]
description: Spring Cache 애노테이션의 동작 원리와 키 생성 규칙, 프록시 함정, CaffeineCacheManager 설정과 지표 수집까지 정리한다.
---

Spring의 캐시 추상화(Cache Abstraction)는 메서드 호출 결과를 캐시에 저장하고, 같은 인자로 다시 호출되면 메서드를 실행하지 않고 저장된 값을 돌려주는 기능이다. 캐시 구현체는 `CacheManager`와 `Cache` 인터페이스 뒤에 숨겨져 있어서, 애노테이션을 그대로 두고 저장소만 Caffeine, Redis, JCache 등으로 바꿀 수 있다. 이 글은 Spring Boot 2.7(Spring Framework 5.3) 기준으로, 같은 JVM 안에 데이터를 두는 Caffeine 로컬 캐시를 붙이는 방법을 다룬다.

## 동작 원리

`@EnableCaching`을 선언하면 캐시 애노테이션이 붙은 빈이 프록시(Proxy)로 감싸진다. 호출 흐름은 다음과 같다.

1. 프록시가 호출을 가로채 인자로 캐시 키를 만든다.
2. `@Cacheable`이면 캐시를 조회하고, 값이 있으면 실제 메서드를 실행하지 않고 반환한다.
3. 값이 없으면 실제 메서드를 실행하고, 결과를 캐시에 넣은 뒤 반환한다.

```java
@Configuration
@EnableCaching
public class CacheConfig {
}
```

Spring Boot에서는 `spring-boot-starter-cache`와 `com.github.ben-manes.caffeine:caffeine`이 클래스패스에 있으면 `CaffeineCacheManager`가 자동 구성된다. Boot 2.7이 관리하는 Caffeine 버전은 2.9.3이다. Caffeine 3.x는 Java 11 이상이 필요하므로, Java 11 이상에서 3.x로 올리려면 버전을 직접 지정한다.

## 세 가지 애노테이션

| 애노테이션 | 메서드 실행 | 캐시 동작 | 용도 |
|---|---|---|---|
| `@Cacheable` | 캐시 미스일 때만 | 조회 후 없으면 저장 | 조회 메서드 |
| `@CachePut` | 항상 | 결과로 덮어씀 | 수정 후 캐시 갱신 |
| `@CacheEvict` | 항상 | 항목 삭제 | 수정·삭제 후 무효화 |

```java
@Service
public class VideoService {

    private final VideoRepository videoRepository;

    public VideoService(VideoRepository videoRepository) {
        this.videoRepository = videoRepository;
    }

    @Cacheable(cacheNames = "video", key = "#id")
    public VideoDto getVideo(Long id) {
        return videoRepository.findById(id)
                .map(VideoDto::from)
                .orElseThrow(() -> new VideoNotFoundException(id));
    }

    @CachePut(cacheNames = "video", key = "#result.id")
    public VideoDto updateTitle(Long id, String title) {
        Video video = videoRepository.findById(id).orElseThrow();
        video.changeTitle(title);
        return VideoDto.from(videoRepository.save(video));
    }

    @CacheEvict(cacheNames = "video", key = "#id")
    public void delete(Long id) {
        videoRepository.deleteById(id);
    }

}
```

`@CacheEvict`는 기본적으로 메서드가 정상 종료된 뒤에 삭제한다. 예외가 발생하면 삭제하지 않는다. `beforeInvocation = true`로 바꾸면 메서드 실행 전에 항상 삭제한다. `allEntries = true`는 키를 무시하고 캐시 전체를 비운다.

공식 문서는 같은 메서드에 `@Cacheable`과 `@CachePut`을 함께 붙이는 것을 강하게 권하지 않는다. 하나는 메서드 실행을 건너뛰고 다른 하나는 반드시 실행하기 때문에 동작을 예측하기 어렵다.

## 키 생성 규칙과 SpEL

`key`를 지정하지 않으면 기본 `SimpleKeyGenerator`가 키를 만든다.

| 파라미터 | 생성되는 키 |
|---|---|
| 없음 | `SimpleKey.EMPTY` |
| 1개 | 그 파라미터 객체 자체 |
| 2개 이상 | 모든 파라미터를 담은 `SimpleKey` |

파라미터 객체가 그대로 키가 되므로 `equals()`와 `hashCode()`가 올바르게 구현되어 있어야 한다. 또 파라미터가 여러 개면 캐시와 무관한 플래그나 페이지 객체까지 키에 섞인다. 이럴 때는 SpEL(Spring Expression Language)로 키를 직접 지정한다.

| 표현식 | 의미 |
|---|---|
| `#id`, `#a0`, `#p0` | 파라미터 이름 또는 인덱스 |
| `#root.methodName` | 호출된 메서드 이름 |
| `#root.args[0]` | 인자 배열 |
| `#result` | 반환값(`unless`, `@CachePut`의 key, `beforeInvocation=false`인 `@CacheEvict`에서만) |

파라미터 이름(`#id`)은 컴파일된 클래스에 파라미터 이름 정보가 있어야 쓸 수 있다. `spring-boot-starter-parent`를 상속한 Maven 프로젝트와 Spring Boot Gradle 플러그인은 `-parameters` 옵션을 켜지만, 다른 빌드 환경에서는 `#a0`처럼 인덱스로 쓰는 편이 안전하다.

```java
@Cacheable(cacheNames = "feed",
           key = "#userId + ':' + #page",
           condition = "#page < 5",
           unless = "#result.isEmpty()")
public List<VideoDto> getFeed(Long userId, int page, boolean debug) {
    return feedQuery.find(userId, page);
}
```

`condition`은 메서드 실행 전에 평가되어 `false`면 캐시를 아예 쓰지 않는다. `unless`는 실행 후에 평가되어 `true`면 결과를 저장하지 않는다. 그래서 `#result`는 `unless`에서만 참조할 수 있다.

## 프록시 함정

캐시는 프록시가 호출을 가로챌 때만 동작한다. 공식 문서가 명시하는 제약은 두 가지다.

- **자기 호출(Self-invocation)**: 같은 객체 안에서 `this.getVideo(id)`로 호출하면 프록시를 거치지 않으므로 캐시가 적용되지 않는다.
- **public이 아닌 메서드**: 프록시 모드에서는 `public` 메서드에만 적용된다. `private`, `protected`, 패키지 전용 메서드에 붙이면 오류 없이 무시된다.

```java
@Service
public class FeedService {

    public List<VideoDto> getHome(List<Long> ids) {
        return ids.stream()
                .map(this::getVideo) // 프록시를 거치지 않아 캐시 미적용
                .collect(Collectors.toList());
    }

    @Cacheable(cacheNames = "video", key = "#id")
    public VideoDto getVideo(Long id) {
        return loadFromDb(id);
    }
}
```

해결책은 캐시 메서드를 별도 빈으로 분리해 주입받아 호출하는 것이다. AspectJ 위빙 모드(`mode = AdviceMode.ASPECTJ`)를 쓰면 바이트코드를 바꾸므로 두 제약이 사라지지만 빌드 설정이 복잡해진다. 또 프록시가 완전히 초기화되기 전인 `@PostConstruct`에서는 캐시 동작을 기대하면 안 된다.

## CaffeineCacheManager 설정

모든 캐시에 같은 설정을 적용할 때는 프로퍼티 하나로 충분하다.

```yaml
spring:
  cache:
    cache-names: video,feed
    caffeine:
      spec: maximumSize=10000,expireAfterWrite=10m,recordStats
```

`spec` 문자열은 Caffeine의 `CaffeineSpec` 형식이다. 쉼표로 구분한 키 또는 키=값이고, 시간은 `d`, `h`, `m`, `s` 단위나 ISO-8601(`PT10M`)로 쓴다. Boot는 다음 순서로 설정을 찾는다.

1. `spring.cache.caffeine.spec`
2. `CaffeineSpec` 빈
3. `Caffeine` 빈

`cache-names`를 지정하면 `CaffeineCacheManager`는 정적 모드가 되어 목록에 없는 이름의 캐시를 런타임에 만들지 않는다. 오타 난 캐시 이름이 조용히 새 캐시를 만드는 일을 막을 수 있다.

### 캐시별로 다른 설정

공통 `spec`은 모든 캐시에 같은 크기와 만료 시간을 적용한다. 캐시마다 다르게 하려면 Spring 5.2.8부터 제공되는 `registerCustomCache`를 쓴다. Boot의 자동 구성을 유지하면서 `CacheManagerCustomizer`로 추가하면 된다.

```java
@Configuration
@EnableCaching
public class CacheConfig {

    @Bean
    public CacheManagerCustomizer<CaffeineCacheManager> caffeineCustomizer() {
        return cacheManager -> {
            cacheManager.registerCustomCache("video",
                    Caffeine.newBuilder()
                            .maximumSize(50_000)
                            .expireAfterWrite(Duration.ofMinutes(10))
                            .recordStats()
                            .build());
            cacheManager.registerCustomCache("feed",
                    Caffeine.newBuilder()
                            .maximumSize(5_000)
                            .expireAfterWrite(Duration.ofSeconds(30))
                            .recordStats()
                            .build());
        };
    }
}
```

직접 등록한 캐시 외의 캐시는 여전히 공통 설정을 따른다.

## 크기 제한과 만료 정책

| 옵션 | 기준 | 적합한 데이터 |
|---|---|---|
| `maximumSize` | 항목 수가 한도를 넘으면 최근·자주 쓰이지 않은 항목부터 제거 | 모든 로컬 캐시에 기본으로 설정 |
| `maximumWeight` + `weigher` | 항목별 가중치 합 | 값 크기 차이가 큰 경우 |
| `expireAfterWrite` | 생성 또는 마지막 값 교체 후 경과 시간 | 시간이 지나면 낡는 데이터 |
| `expireAfterAccess` | 마지막 읽기·쓰기 후 경과 시간 | 세션처럼 비활성 시 버려도 되는 데이터 |

`expireAfterAccess`만 쓰면 자주 읽히는 항목은 계속 연장되어 원본이 바뀌어도 영원히 갱신되지 않을 수 있다. DB 데이터를 캐시할 때는 `expireAfterWrite`로 최대 낡음 시간을 보장하고, `maximumSize`로 메모리 상한을 둔다. `maximumSize`와 `maximumWeight`는 함께 쓸 수 없다.

만료 처리는 별도 스레드가 아니라 쓰기 시점과 가끔의 읽기 시점에 수행하는 유지 보수 작업(maintenance)에서 이루어진다. 만료 즉시 제거가 필요하면 `Caffeine.scheduler(Scheduler.systemScheduler())`를 지정한다.

## 통계와 Actuator 지표

`recordStats`를 켜면 `Cache.stats()`로 적중률(hitRate), 제거 수, 평균 로딩 시간을 볼 수 있다. Actuator와 Micrometer가 있으면 Boot가 시작 시점에 존재하는 캐시를 자동으로 계측하고 `cache.` 접두사로 지표를 등록한다.

| 지표 | 내용 |
|---|---|
| `cache.gets` (`result=hit`/`miss`) | 적중·미스 횟수 |
| `cache.puts` | 저장 횟수 |
| `cache.evictions` | 제거 횟수 |
| `cache.size` | 현재 항목 수 추정치 |

지표에는 캐시 이름(`cache`, `name`)과 `CacheManager` 빈 이름(`cache.manager`) 태그가 붙는다. 주의할 점은 두 가지다. Caffeine은 `recordStats` 없이 만든 캐시의 통계를 0으로 보고한다. 또 시작 이후 동적으로 만들어진 캐시는 자동 등록되지 않으므로 `CacheMetricsRegistrar` 빈으로 직접 등록해야 한다. `cache-names`나 `registerCustomCache`로 미리 정의하면 이 문제가 없다.

```bash
curl -s "localhost:8080/actuator/metrics/cache.gets?tag=cache:video&tag=result:miss"
```

## null 캐싱

Caffeine 자체는 null 값을 저장하지 못한다. `CaffeineCacheManager`의 `allowNullValues` 기본값은 `true`이고, 내부 홀더 객체로 감싸서 null을 저장한다. 존재하지 않는 ID를 반복 조회하는 요청이 DB까지 가지 않는다는 장점이 있지만, 나중에 그 ID로 데이터가 생기면 만료 전까지 계속 null이 반환된다.

| 방법 | 설정 | 동작 |
|---|---|---|
| null도 캐싱 | 기본값 | 없는 데이터 조회도 캐시 적중 |
| null 캐싱 금지 | `setAllowNullValues(false)` | null 반환 시 예외 발생 |
| 특정 메서드만 제외 | `unless = "#result == null"` | null은 저장하지 않음 |

`allowNullValues=false`인 상태에서 메서드가 null을 반환하면 `IllegalArgumentException`이 발생한다. 메서드별로 제어하려면 `unless`를 쓴다. `Optional` 반환 타입도 지원되며, 값이 없으면 null이 저장되고 `#result`는 `Optional`이 아닌 내부 객체를 가리킨다.

## 정리

1. `@EnableCaching`은 프록시로 메서드 호출을 가로채며, `@Cacheable`은 조회, `@CachePut`은 갱신, `@CacheEvict`는 무효화에 쓴다.
2. 기본 키는 파라미터로 만들어지므로 파라미터가 여러 개면 SpEL로 필요한 값만 키에 넣는다.
3. 자기 호출과 `public`이 아닌 메서드에는 캐시가 적용되지 않으며, 오류 없이 무시된다.
4. 공통 설정은 `spring.cache.caffeine.spec`, 캐시별 설정은 `registerCustomCache`로 한다.
5. DB 데이터에는 `maximumSize`와 `expireAfterWrite`를 함께 설정해 메모리와 낡음 시간의 상한을 둔다.
6. `recordStats`를 켜야 Actuator의 `cache.gets` 적중·미스 지표가 의미 있는 값을 낸다.
7. null 캐싱은 기본으로 켜져 있으므로 필요에 따라 `unless`나 `allowNullValues`로 제어한다.
