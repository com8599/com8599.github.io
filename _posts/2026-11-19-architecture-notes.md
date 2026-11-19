---
layout: post
title: 지금 아키텍처 글에서 반복되는 구조
date: 2026-11-19
tags: [architecture, agents, event-driven]
description: 2026년 공개 글에서 반복되는 에이전트 플랫폼, 이벤트 스트림, 권한, 평가의 뼈대.
---

2026년 가을에 공개된 플랫폼 엔지니어링 정리와 클라우드 글을 겹쳐 보면, 새 상자 이름보다 같은 경계가 먼저 보인다. 아래는 그 경계를 다섯 개로 자른 메모다. 구현 절차가 아니라, 다음에 무엇을 읽을지 고르는 지도다.

## 에이전트는 포털의 방문자가 아니다

내부 개발자 포털은 사람이 화면을 읽고 누르는 전제로 만들어졌다. 에이전트에게는 화면 대신 부를 수 있는 기능, 믿을 수 있는 상태, 보고 다음 행동을 정할 수 있는 오류가 필요하다. Platform Engineering 커뮤니티의 2026년 10월 글은 이 차이를 IDP에서 Agentic Engineering Platform으로 옮기는 일로 적는다. Uber, LinkedIn, AWS, Google, Azure 사례를 겹친 결론은 한 줄이다. MCP 서버를 기존 포털에 붙이는 것으로 끝나지 않고, 등록부와 게이트웨이, 에이전트 신원, 의미 있는 상태 계층이 따로 있어야 한다.

## 상태는 스트림으로 남긴다

Confluent가 정리한 agentic event-driven 구조는 신호, 판단, 행동을 동기 호출 대신 불변 이벤트로 흘린다. 에이전트는 스트림을 읽고, 공유된 상태를 보고, 결정을 다시 이벤트로 내보낸다. 그 행동이 만든 새 이벤트가 다음 입력이다. 글은 이를 생산자, 스트림 백본, 상태 있는 처리, 공유 컨텍스트, 에이전트 실행, 정책, 명령 방출, 관측의 여덟 층으로 나눈다. 핵심은 모델이 아니라, 상태가 서비스 안에 숨지 않고 스트림 위에 남아 있다는 점이다.

## 할 수 있는 것과 해도 되는 것

Conf42 Platform Engineering 2026 라운드업에서 반복된 구분은 능력과 권한이다. 에이전트가 원인일 가능성을 높게 봐도, 롤백은 만료되는 범위의 권한과 별도의 확인을 거쳐야 한다. 프롬프트가 정책을 속여도, 내보내기 같은 동작은 프롬프트가 줄 수 없는 인가를 다시 통과해야 한다. 같은 글들이 말하는 trust mode는 읽기, 제안, 실행을 한 스위치로 두지 않는 것이다.

## 앞문은 게이트웨이, 출고는 평가

AWS가 공개한 AgentCore 기준 플랫폼은 플랫폼 계정과 워크스트림 셀을 나눈다. 플랫폼은 버전된 템플릿, 추론 게이트웨이, 가드레일, 릴리스를 맡고, 각 셀은 자기 런타임과 메모리, 허용된 도구만 연 게이트웨이를 가진다. 셀 하나는 다른 팀의 릴리스와 묶이지 않고 배포되거나 롤백된다. Coinbase 쪽 발표를 요약한 라운드업은 모델 호출에도 예산, 안전 검사, 평가를 통과한 모델로만의 장애 조치를 둔다. 게이트웨이가 들어가는 문을 좁히면, 평가는 그 문이 새 모델에서도 같은 일을 하는지 확인하는 출고 기준이다.

## 서비스 사이는 여전히 이벤트

에이전트 층이 위에 얹혀도, 서비스끼리의 계약으로 자주 호출되는 이름은 그대로다. Walmart 발표 요약은 소매 공급망을 Kafka, CQRS, saga로 설명하고, IBM 발표는 CDC 파이프라인을 팀별 셀프서비스로 여는 쪽을 다룬다. Gartner가 2026년 10월에 낸 클라우드 네이티브 애플리케이션·에이전트 아키텍처 요약도 같은 방향을 가리킨다. 모듈러하고, API가 먼저이며, 이벤트 기반인 서비스 구성 위에 에이전트를 올리는 일이다.

다음에 한 편을 더 쓴다면 다섯 경계 중 하나를 고른다. 후보는 에이전트 신원, 스트림 위의 공유 상태, 읽기·제안·실행의 분리, 평가를 통과해야 나가는 릴리스, 그리고 saga가 실패할 때의 보상이다.

## 읽은 곳

- [Agent-first IDP](https://platformengineering.org/blog/agent-first-idp-how-big-tech-and-the-clouds-are-preparing-platforms-for-agents)
- [Agentic Event-Driven Systems Architecture](https://www.confluent.io/blog/autonomous-agentic-event-driven-systems-architecture/)
- [Conf42 Platform Engineering 2026](https://www.conf42.com/blog/platform2026/platform-engineering-2026-roundup-agents-as-users)
- [Agentic AI Platform on Amazon Bedrock AgentCore](https://aws.amazon.com/blogs/machine-learning/building-an-agentic-ai-platform-on-amazon-bedrock-agentcore/)
- [Gartner, Cloud-Native Application and Agent Architecture](https://www.gartner.com/en/documents/8583673)
