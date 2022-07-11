---
layout: post
title: Kotlin + JPA — no-arg와 all-open 플러그인
date: 2022-07-11
tags: [spring-boot]
description: JPA 명세가 요구하는 것과 Kotlin 클래스의 기본 성질이 충돌하는 지점.
---

Kotlin 클래스는 기본적으로 `final`이고, 주 생성자에 매개변수가 있으면 인자 없는 생성자가 없다. JPA는 이 두 가지를 모두 요구한다.

## JPA 명세의 요구사항

1. 엔티티는 `public` 또는 `protected` **기본 생성자**를 가져야 한다. Hibernate는 조회 결과로 객체를 만들 때 기본 생성자를 호출한 뒤 필드를 채운다.
2. 엔티티 클래스는 **final이면 안 되고**, 메서드와 영속 인스턴스 변수도 final이면 안 된다. Hibernate의 지연 로딩(lazy loading) 프록시(proxy)가 엔티티를 상속해 만들어지기 때문이다.

기본 생성자가 없으면 조회 시 `org.hibernate.InstantiationException: No default constructor for entity`가 발생한다. final 클래스는 예외 없이 저장·조회되지만, 프록시를 만들 수 없어 지연 로딩이 동작하지 않는 형태로 나타난다.

## 플러그인

| 플러그인 | 역할 | 대상 |
|---|---|---|
| `kotlin-noarg` | 합성(synthetic) 기본 생성자 추가 | 지정한 어노테이션 |
| `kotlin-jpa` | no-arg 프리셋(preset) | `@Entity`, `@Embeddable`, `@MappedSuperclass` |
| `kotlin-allopen` | 클래스와 멤버를 open으로 | 지정한 어노테이션 |
| `kotlin-spring` | all-open 프리셋 | `@Component`, `@Transactional`, `@Async` 등 |

`kotlin-spring`은 `@Entity`를 열지 않는다. 엔티티는 all-open 대상에 직접 추가해야 한다.

```kotlin
plugins {
    kotlin("plugin.spring") version "1.6.21"
    kotlin("plugin.jpa") version "1.6.21"
}

allOpen {
    annotation("javax.persistence.Entity")
    annotation("javax.persistence.MappedSuperclass")
    annotation("javax.persistence.Embeddable")
}
```

no-arg가 만드는 생성자는 기본적으로 프로퍼티 초기화식과 `init` 블록을 실행하지 않는다. 필요하면 `noArg { invokeInitializers = true }`를 설정한다.

## data class를 엔티티로 쓰지 않는 이유

- `equals`/`hashCode`가 주 생성자에 선언한 프로퍼티를 모두 사용한다. `id`가 주 생성자에 있으면 저장 전후로 해시가 바뀌어 `Set`에서 찾을 수 없다.
- 주 생성자에 둔 연관 프로퍼티가 `toString`, `equals`에 포함되어 양방향 관계에서 무한 호출이 생기고, 지연 로딩이 의도치 않게 초기화된다.
- `copy()`는 영속성 컨텍스트(persistence context)가 관리하지 않는 새 객체를 만든다.

## 권장 형태

```kotlin
@Entity
class Member(
    @Column(nullable = false)
    var name: String,
) {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    val id: Long? = null

    @OneToMany(mappedBy = "member")
    val orders: MutableList<Order> = mutableListOf()

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is Member) return false
        return id != null && id == other.id
    }

    override fun hashCode(): Int = javaClass.hashCode()
}
```

- 일반 `class`로 선언하고 식별자 기준으로 `equals`를 구현한다.
- `hashCode`는 영속 전후로 바뀌지 않도록 클래스 기준 상수를 쓴다.
