package com.warroomlive.chat;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Index;
import jakarta.persistence.Table;

/** JPA row for a chat message; used only under the {@code postgres} profile. */
@Entity
@Table(name = "chat_message", indexes = @Index(name = "idx_chat_room_id", columnList = "room, id"))
public class ChatMessageEntity {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false)
    private String room;

    @Column(name = "from_id", nullable = false)
    private String fromId;

    @Column(nullable = false)
    private String name;

    @Column(nullable = false, length = 4000)
    private String text;

    @Column(name = "ts", nullable = false)
    private long ts;

    protected ChatMessageEntity() {
    }

    ChatMessageEntity(String room, StoredMessage m) {
        this.room = room;
        this.fromId = m.fromId();
        this.name = m.name();
        this.text = m.text();
        this.ts = m.ts();
    }

    StoredMessage toStored() {
        return new StoredMessage(fromId, name, text, ts);
    }
}
