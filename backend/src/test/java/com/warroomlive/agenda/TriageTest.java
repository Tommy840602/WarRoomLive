package com.warroomlive.agenda;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class TriageTest {

    @Test
    void parsesTheTwoStoredValues() {
        assertThat(Triage.parse("NOW")).isEqualTo(Triage.NOW);
        assertThat(Triage.parse("later")).isEqualTo(Triage.LATER);
        assertThat(Triage.parse(" Now ")).isEqualTo(Triage.NOW);
    }

    @Test
    void treatsAbsenceAndAutoAsHandingTheItemBackToTheClock() {
        // These are the same request — "stop overruling the clock" — and they
        // must not be confused with NOW, which is a decision somebody made.
        assertThat(Triage.parse(null)).isNull();
        assertThat(Triage.parse("")).isNull();
        assertThat(Triage.parse("   ")).isNull();
        assertThat(Triage.parse("auto")).isNull();
        assertThat(Triage.parse("AUTO")).isNull();
    }

    @Test
    void refusesAWordItDoesNotKnow() {
        // Filing an unrecognised triage under the clock's opinion would look to
        // the caller exactly like it had worked.
        assertThatThrownBy(() -> Triage.parse("urgent"))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void doesNotAcceptDoneAsAStoredValue() {
        // DONE is a fact about the work with a time and an author, not an
        // opinion about attention; the controller turns it into a completion.
        assertThatThrownBy(() -> Triage.parse("DONE"))
                .isInstanceOf(IllegalArgumentException.class);
    }
}
