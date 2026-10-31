package cl.coders.faketraveler;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.List;

public class RouteSimulatorTest {

    // Two points ~111.2 m apart along a meridian, and a third ~111.2 m east of the second at the equator.
    private static final LatLng A = new LatLng(0, 0);
    private static final LatLng B = new LatLng(0.001, 0);
    private static final LatLng C = new LatLng(0.001, 0.001);
    private static final double LEG = RouteSimulator.distanceMeters(A, B);

    @Test
    public void distanceAndBearing() {
        assertEquals(111.19, LEG, 0.05);
        assertEquals(0f, RouteSimulator.bearingDegrees(A, B), 0.01f);
        assertEquals(90f, RouteSimulator.bearingDegrees(B, C), 0.01f);
        assertEquals(180f, RouteSimulator.bearingDegrees(B, A), 0.01f);
    }

    @Test
    public void singlePointStandsStill() {
        RouteSimulator sim = new RouteSimulator(List.of(A), 10, RouteSimulator.LoopMode.LOOP);
        RouteSimulator.State s = sim.stateAt(100);
        assertEquals(0, s.lat(), 0);
        assertEquals(0f, s.speed(), 0);
        assertFalse(s.finished());
    }

    @Test
    public void onceInterpolatesAndStopsAtEnd() {
        RouteSimulator sim = new RouteSimulator(List.of(A, B, C), 1, RouteSimulator.LoopMode.ONCE);
        RouteSimulator.State half = sim.stateAt(LEG / 2);
        assertEquals(0.0005, half.lat(), 1e-7);
        assertEquals(0f, half.bearing(), 0.01f);
        assertEquals(1f, half.speed(), 0);

        RouteSimulator.State second = sim.stateAt(LEG * 1.5);
        assertEquals(0.001, second.lat(), 1e-7);
        assertEquals(90f, second.bearing(), 0.01f);

        RouteSimulator.State end = sim.stateAt(LEG * 10);
        assertTrue(end.finished());
        assertEquals(0f, end.speed(), 0);
        assertEquals(C.lng(), end.lng(), 1e-12);
    }

    @Test
    public void loopWalksBackToStart() {
        RouteSimulator sim = new RouteSimulator(List.of(A, B, C), 1, RouteSimulator.LoopMode.LOOP);
        double total = sim.totalMeters();
        assertEquals(LEG * 2 + RouteSimulator.distanceMeters(C, A), total, 1e-6);
        // Somewhere on the closing leg C -> A, heading south-west.
        RouteSimulator.State closing = sim.stateAt(LEG * 2 + 10);
        assertEquals(225f, closing.bearing(), 0.5f);
        // After a full lap we are back at A.
        RouteSimulator.State lap = sim.stateAt(total);
        assertEquals(0, lap.lat(), 1e-9);
        assertFalse(lap.finished());
    }

    @Test
    public void pingPongTurnsAround() {
        RouteSimulator sim = new RouteSimulator(List.of(A, B), 1, RouteSimulator.LoopMode.PING_PONG);
        RouteSimulator.State back = sim.stateAt(LEG * 1.25);
        assertEquals(0.00075, back.lat(), 1e-7);
        assertEquals(180f, back.bearing(), 0.01f);
        RouteSimulator.State again = sim.stateAt(LEG * 2.25);
        assertEquals(0.00025, again.lat(), 1e-7);
        assertEquals(0f, again.bearing(), 0.01f);
    }
}
