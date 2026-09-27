# Requirements: Bakery Pre-order App (proof of concept)

## Intent Analysis

From the approved intent statement (`intent-statement`): customers of one bakery can't be sure the items they want will be available, so they want to reserve them in advance. The proof of concept succeeds when a customer places a pre-order, sees it confirmed as reserved, and bakery staff can see the order. This analysis defines "reserved" as items held back from other customers (Q1), with pickup in the bakery at a chosen time slot (Q2) and payment at collection (Q3).

## Functional Requirements

### Ordering

- **FR1** A customer can place a pre-order for one or more items and choose a pickup time slot. Given an item with available stock and a pickup slot, when the customer submits the pre-order, then the order is saved with the chosen items, quantities, slot, and the customer's name and phone number, and the customer is shown an order reference.
- **FR2** A submitted pre-order holds its items back from other customers. Given an item with 3 in stock, when a customer reserves 2, then other customers can reserve at most 1 more until the order is collected or cancelled.
- **FR3** A customer cannot reserve more than is available. Given an item with 1 left in stock, when a customer tries to reserve 2, then the order is refused and the customer sees that only 1 is available.
- **FR4** A customer sees their pre-order confirmed as reserved. Given a successfully submitted pre-order, when it is saved, then the customer sees a confirmation showing the items, quantities, pickup slot and the status "Reserved".

### Bakery staff

- **FR5** Bakery staff can see every reserved pre-order. Given one or more reserved pre-orders, when a staff member opens the order list, then each order shows its reference, the customer's name and phone number, items, quantities, pickup slot and status.
- **FR6** Bakery staff can mark a pre-order as collected or cancelled, which releases its hold. Given a reserved order, when staff mark it collected or cancelled, then its status changes and cancelled items become available to other customers again.

## Non-Functional Requirements

- **NFR1** The reservation confirmation (FR4) appears within 5 seconds of the customer submitting the pre-order, for 95% of submissions.
- **NFR2** Two customers reserving the last unit of an item at the same time never both succeed: at most one reservation is accepted and the other sees the item as unavailable.

## Constraints

- There is no online payment; customers pay at the bakery when collecting (Q3).
- Orders are collected in the bakery; there is no delivery (Q2).
- The staff order list is protected by a single shared staff password.

## Assumptions

- Stock quantities for each item are entered by bakery staff; this proof of concept does not connect to a stock or till system. [assumption]

## Out of Scope

- Online payment and refunds.
- Delivery.
- Multiple bakeries.
- Customer accounts; a customer finds their order again by its reference.

## Open Questions

- How far ahead a customer can reserve, and how time slots are defined, is left to the build; both are simple settings in a proof of concept.
