package com.warroomlive.web;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The ceiling is the only thing between one request and a response the size of
 * the table, so it is the behaviour worth pinning down.
 */
class PagesTest {

    @Test
    void honoursAReasonableRequest() {
        assertThat(Pages.limit(25, 50, 200)).isEqualTo(25);
        assertThat(Pages.offset(100)).isEqualTo(100);
    }

    @Test
    void clampsAnOversizedRequestRatherThanRefusingIt() {
        // A caller asking for a million rows wants as many as it can have.
        assertThat(Pages.limit(1_000_000, 50, 200)).isEqualTo(200);
    }

    @Test
    void fallsBackToTheDefaultForNonsense() {
        assertThat(Pages.limit(0, 50, 200)).isEqualTo(50);
        assertThat(Pages.limit(-5, 50, 200)).isEqualTo(50);
        // A negative offset is a caller bug, not an instruction: LIMIT with a
        // negative OFFSET is an error in Postgres, so it must never get through.
        assertThat(Pages.offset(-1)).isZero();
    }
}
