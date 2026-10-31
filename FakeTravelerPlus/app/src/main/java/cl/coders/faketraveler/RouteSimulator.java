package cl.coders.faketraveler;

import androidx.annotation.NonNull;

import java.util.ArrayList;
import java.util.List;

/**
 * Computes where a traveler moving at a constant speed along a polyline is after a given time.
 * Pure Java (no Android APIs) so it can be unit tested on the JVM.
 */
public final class RouteSimulator {

    public enum LoopMode {
        /** Walk the route once and stay at the last waypoint. */
        ONCE,
        /** Go back to the first waypoint after the last one and start over. */
        LOOP,
        /** Walk the route forwards, then backwards, and repeat. */
        PING_PONG
    }

    /**
     * Position on the route.
     *
     * @param bearing  direction of travel in degrees clockwise from north, [0, 360)
     * @param speed    meters per second, 0 when standing still
     * @param finished true once a {@link LoopMode#ONCE} route reached its last waypoint
     */
    public record State(double lat, double lng, float bearing, float speed, boolean finished) {
    }

    private static final double EARTH_RADIUS_M = 6_371_008.8;

    @NonNull
    private final List<LatLng> points;
    /** cumulative[i] = distance in meters from points[0] to points[i]. */
    @NonNull
    private final double[] cumulative;
    private final double speedMps;
    @NonNull
    private final LoopMode loopMode;

    public RouteSimulator(@NonNull List<LatLng> waypoints, double speedMps, @NonNull LoopMode loopMode) {
        if (waypoints.isEmpty()) throw new IllegalArgumentException("Route needs at least one waypoint");
        if (speedMps < 0) throw new IllegalArgumentException("Speed must not be negative");

        points = new ArrayList<>(waypoints);
        // A loop closes the route so that the jump back to the start is walked, not teleported.
        if (loopMode == LoopMode.LOOP && points.size() > 1) points.add(points.get(0));

        cumulative = new double[points.size()];
        for (int i = 1; i < points.size(); i++)
            cumulative[i] = cumulative[i - 1] + distanceMeters(points.get(i - 1), points.get(i));

        this.speedMps = speedMps;
        this.loopMode = loopMode;
    }

    /** Length of one pass over the route in meters (including the closing leg for LOOP). */
    public double totalMeters() {
        return cumulative[cumulative.length - 1];
    }

    @NonNull
    public State stateAt(double elapsedSeconds) {
        double total = totalMeters();
        if (total <= 0 || speedMps <= 0) {
            LatLng p = points.get(0);
            return new State(p.lat(), p.lng(), 0f, 0f, loopMode == LoopMode.ONCE);
        }

        double travelled = Math.max(0, elapsedSeconds) * speedMps;
        boolean backwards = false;
        switch (loopMode) {
            case ONCE -> {
                if (travelled >= total) {
                    int last = points.size() - 1;
                    LatLng p = points.get(last);
                    return new State(p.lat(), p.lng(), bearingDegrees(points.get(last - 1), p), 0f, true);
                }
            }
            case LOOP -> travelled %= total;
            case PING_PONG -> {
                travelled %= 2 * total;
                if (travelled > total) {
                    travelled = 2 * total - travelled;
                    backwards = true;
                }
            }
        }

        int seg = segmentAt(travelled);
        LatLng a = points.get(seg);
        LatLng b = points.get(seg + 1);
        double segLen = cumulative[seg + 1] - cumulative[seg];
        double f = segLen > 0 ? (travelled - cumulative[seg]) / segLen : 0;
        // Linear interpolation in degrees is accurate enough for the short legs drawn on a map.
        double lat = a.lat() + (b.lat() - a.lat()) * f;
        double lng = a.lng() + (b.lng() - a.lng()) * f;
        float bearing = backwards ? bearingDegrees(b, a) : bearingDegrees(a, b);
        return new State(lat, lng, bearing, (float) speedMps, false);
    }

    /** Index i of the leg points[i] -> points[i + 1] that contains the given distance. */
    private int segmentAt(double travelled) {
        int lo = 0, hi = cumulative.length - 2;
        while (lo < hi) {
            int mid = (lo + hi + 1) >>> 1;
            if (cumulative[mid] <= travelled) lo = mid;
            else hi = mid - 1;
        }
        return lo;
    }

    /** Great-circle (haversine) distance. */
    public static double distanceMeters(@NonNull LatLng a, @NonNull LatLng b) {
        double dLat = Math.toRadians(b.lat() - a.lat());
        double dLng = Math.toRadians(b.lng() - a.lng());
        double h = Math.sin(dLat / 2) * Math.sin(dLat / 2)
                + Math.cos(Math.toRadians(a.lat())) * Math.cos(Math.toRadians(b.lat()))
                * Math.sin(dLng / 2) * Math.sin(dLng / 2);
        return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
    }

    /** Initial bearing from a to b in degrees, [0, 360). */
    public static float bearingDegrees(@NonNull LatLng a, @NonNull LatLng b) {
        double phi1 = Math.toRadians(a.lat());
        double phi2 = Math.toRadians(b.lat());
        double dLng = Math.toRadians(b.lng() - a.lng());
        double y = Math.sin(dLng) * Math.cos(phi2);
        double x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLng);
        double deg = Math.toDegrees(Math.atan2(y, x));
        return (float) ((deg + 360) % 360);
    }
}
