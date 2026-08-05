package com.warroomlive.chat;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class InMemoryChatRepositoryTest {

    private StoredMessage msg(String text) {
        return new StoredMessage("peer", "Peer", text, 0L);
    }

    @Test
    void recentReturnsMessagesOldestFirst() {
        InMemoryChatRepository repo = new InMemoryChatRepository(100);
        repo.append("r", msg("a"));
        repo.append("r", msg("b"));
        repo.append("r", msg("c"));

        assertThat(repo.recent("r", 10).stream().map(StoredMessage::text)).containsExactly("a", "b", "c");
    }

    @Test
    void recentLimitReturnsTheNewestN() {
        InMemoryChatRepository repo = new InMemoryChatRepository(100);
        for (String t : new String[] {"a", "b", "c", "d"}) {
            repo.append("r", msg(t));
        }
        assertThat(repo.recent("r", 2).stream().map(StoredMessage::text)).containsExactly("c", "d");
    }

    @Test
    void capacityEvictsOldestMessages() {
        InMemoryChatRepository repo = new InMemoryChatRepository(2);
        for (String t : new String[] {"a", "b", "c"}) {
            repo.append("r", msg(t));
        }
        assertThat(repo.recent("r", 10).stream().map(StoredMessage::text)).containsExactly("b", "c");
    }

    @Test
    void unknownRoomIsEmpty() {
        assertThat(new InMemoryChatRepository(100).recent("nope", 10)).isEqualTo(List.of());
    }
}
