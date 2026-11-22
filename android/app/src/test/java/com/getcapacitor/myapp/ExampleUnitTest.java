package com.getcapacitor.myapp;

import static org.junit.Assert.*;

import de.example.securityops.data.OutboxEntity;
import org.junit.Test;

/**
 * Example local unit test, which will execute on the development machine (host).
 *
 * @see <a href="http://d.android.com/tools/testing">Testing documentation</a>
 */
public class ExampleUnitTest {

    @Test
    public void addition_isCorrect() throws Exception {
        assertEquals(4, 2 + 2);
    }

    @Test
    public void outboxDefaultsToPendingAndPreservesIdempotentPayload() {
        OutboxEntity item = new OutboxEntity(
                "event-1",
                "alarms.panic",
                "/alarms/panic",
                "{\"client_event_id\":\"event-1\"}",
                System.currentTimeMillis(),
                "pending",
                null);

        assertEquals("pending", item.getStatus());
        assertEquals("event-1", item.getId());
        assertTrue(item.getPayload().contains("client_event_id"));
    }
}
