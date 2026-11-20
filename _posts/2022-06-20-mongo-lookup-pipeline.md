---
layout: post
title: MongoDB $lookup 파이프라인과 Spring Data 커스텀 연산
date: 2022-06-20
tags: [spring-boot]
description: let/pipeline 형태의 $lookup을 Spring Data MongoDB에서 쓰기 위한 AggregationOperation 구현.
---

`$lookup`은 다른 컬렉션의 문서를 붙이는 집계 단계다. 단순 동등 조인(equality match) 외에 조건, 정렬, 개수 제한을 걸려면 `let`과 `pipeline` 형태를 써야 한다.

## 두 가지 형태

```js
// 동등 조인
{ $lookup: { from: "comments", localField: "_id", foreignField: "postId", as: "comments" } }

// 파이프라인 조인 (3.6+)
{
  $lookup: {
    from: "comments",
    let: { postId: "$_id" },
    pipeline: [
      { $match: { $expr: { $eq: ["$postId", "$$postId"] }, deleted: false } },
      { $sort: { createdAt: -1 } },
      { $limit: 3 }
    ],
    as: "recentComments"
  }
}
```

- `$$변수`는 `let`에서 정의한 값이다.
- 파이프라인 안에서 필터링하므로 필요한 문서만 가져온다. 동등 조인 후 `$filter`나 `$slice`로 자르면 일단 전부 조인한 뒤 버린다.
- MongoDB 5.0부터는 `localField`/`foreignField`와 `pipeline`을 함께 쓸 수 있다.

## Spring Data MongoDB의 한계

Spring Data MongoDB 3.x의 `Aggregation.lookup()`과 `LookupOperation`은 `from`, `localField`, `foreignField`, `as`만 받는다. `let`/`pipeline` 형태는 직접 구현해야 한다.

## 커스텀 AggregationOperation

```kotlin
import org.bson.Document
import org.springframework.data.mongodb.core.aggregation.AggregationOperationContext
import org.springframework.data.mongodb.core.aggregation.ExposedFields
import org.springframework.data.mongodb.core.aggregation.Fields
import org.springframework.data.mongodb.core.aggregation.FieldsExposingAggregationOperation.InheritsFieldsAggregationOperation

class PipelineLookupOperation(
    private val from: String,
    private val let: Document,
    private val pipeline: List<Document>,
    private val asField: String,
) : InheritsFieldsAggregationOperation {

    override fun toDocument(context: AggregationOperationContext): Document =
        Document("\$lookup", Document()
            .append("from", from)
            .append("let", let)
            .append("pipeline", pipeline)
            .append("as", asField))

    override fun getFields(): ExposedFields =
        ExposedFields.synthetic(Fields.fields(asField))
}
```

`toDocument()`만 구현하면 단계 자체는 동작한다. 다만 앞쪽에 `project`, `group`처럼 필드를 노출하는 단계가 있으면, 이후 단계에서 `as` 필드를 `project("recentComments")`처럼 참조할 때 `Invalid reference` 예외가 난다. Spring Data는 필드를 노출하는 단계를 지나면 그 단계가 노출한 필드만으로 참조를 검증하기 때문이다.

- `FieldsExposingAggregationOperation`: `getFields()`로 이 단계가 만드는 필드를 컨텍스트에 알린다.
- `FieldsExposingAggregationOperation.InheritsFieldsAggregationOperation`: 위 인터페이스를 상속한 중첩 인터페이스로, 이전 단계의 필드도 유지한다. `$lookup`은 기존 필드에 하나를 추가하는 단계이므로 이쪽을 구현한다. 내장 `LookupOperation`도 같은 인터페이스를 구현한다.

## 사용

```kotlin
val lookup = PipelineLookupOperation(
    from = "comments",
    let = Document("postId", "\$_id"),
    pipeline = listOf(
        Document("\$match", Document("\$expr", Document("\$eq", listOf("\$postId", "\$\$postId"))).append("deleted", false)),
        Document("\$sort", Document("createdAt", -1)),
        Document("\$limit", 3),
    ),
    asField = "recentComments",
)

val aggregation = Aggregation.newAggregation(
    Aggregation.match(Criteria.where("boardId").`is`(boardId)),
    lookup,
    Aggregation.project("title", "recentComments"),
)
mongoTemplate.aggregate(aggregation, "posts", PostWithComments::class.java)
```

## 성능

- 파이프라인 안의 `$match`에 쓰는 필드(`postId`, `deleted`, `createdAt`)에 복합 인덱스(compound index)를 둔다.
- `$expr` 안에서는 `$eq`, `$lt`, `$lte`, `$gt`, `$gte` 비교만 `from` 컬렉션의 인덱스를 쓸 수 있다. 필드와 상수(`let` 변수가 상수로 풀리는 경우)의 비교여야 하고, 멀티키(multikey)·부분(partial)·희소(sparse) 인덱스는 쓰지 않는다. 실행 계획(`explain`)으로 `IXSCAN`인지 확인한다.
