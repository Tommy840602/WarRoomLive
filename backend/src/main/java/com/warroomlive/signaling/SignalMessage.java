package com.warroomlive.signaling;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.JsonNode;

/**
 * A single signaling message exchanged between a client and the server.
 *
 * <p>The same envelope is used in both directions. {@code type} drives routing:
 * <ul>
 *   <li>{@code join} / {@code leave} — client announces room membership.</li>
 *   <li>{@code offer} / {@code answer} / {@code candidate} — WebRTC negotiation,
 *       relayed to the single peer named in {@code to}.</li>
 *   <li>{@code chat} — a text message from {@code from}, broadcast to the rest of the room.</li>
 *   <li>{@code state} — {@code from}'s media on/off flags, broadcast to the rest of the room.</li>
 *   <li>{@code reaction} — an ephemeral emoji from {@code from}, broadcast to the rest of the room.</li>
 *   <li>{@code hand} — {@code from}'s raise-hand flag, broadcast to the rest of the room.</li>
 *   <li>{@code peers} — server → client, the peers already in the room on join.</li>
 *   <li>{@code peer-joined} / {@code peer-left} — server → client room membership events.</li>
 *   <li>{@code error} — server → client, human-readable reason in {@code payload}.</li>
 * </ul>
 *
 * @param type    message kind (see above); never null
 * @param room    room identifier the message applies to
 * @param from    peer id of the sender
 * @param to      target peer id for peer-to-peer relay ({@code offer}/{@code answer}/{@code candidate})
 * @param payload opaque body — SDP, ICE candidate, peer list, or error text
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record SignalMessage(
        String type,
        String room,
        String from,
        String to,
        JsonNode payload
) {
    public static final String TYPE_JOIN = "join";
    public static final String TYPE_LEAVE = "leave";
    public static final String TYPE_OFFER = "offer";
    public static final String TYPE_ANSWER = "answer";
    public static final String TYPE_CANDIDATE = "candidate";
    public static final String TYPE_CHAT = "chat";
    public static final String TYPE_STATE = "state";
    public static final String TYPE_REACTION = "reaction";
    public static final String TYPE_HAND = "hand";
    public static final String TYPE_PEERS = "peers";
    public static final String TYPE_PEER_JOINED = "peer-joined";
    public static final String TYPE_PEER_LEFT = "peer-left";
    public static final String TYPE_ERROR = "error";
}
