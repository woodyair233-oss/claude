package cl.coders.faketraveler;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import androidx.annotation.NonNull;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * A saved place (one point) or route (two or more points).
 */
public record Favorite(@NonNull String name, @NonNull List<LatLng> points) {

    @NonNull
    private static final String PREF_KEY = "favorites";

    public boolean isRoute() {
        return points.size() > 1;
    }

    @NonNull
    public static List<Favorite> loadAll(@NonNull Context ctx) {
        List<Favorite> list = new ArrayList<>();
        String json = prefs(ctx).getString(PREF_KEY, "[]");
        try {
            JSONArray arr = new JSONArray(json);
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.getJSONObject(i);
                list.add(new Favorite(o.getString("name"), decodePoints(o.getJSONArray("points"))));
            }
        } catch (JSONException e) {
            Log.e(Favorite.class.getSimpleName(), "Could not read favorites!", e);
        }
        return list;
    }

    public static void saveAll(@NonNull Context ctx, @NonNull List<Favorite> favorites) {
        JSONArray arr = new JSONArray();
        try {
            for (Favorite f : favorites) {
                JSONObject o = new JSONObject();
                o.put("name", f.name());
                o.put("points", encodePoints(f.points()));
                arr.put(o);
            }
        } catch (JSONException e) {
            Log.e(Favorite.class.getSimpleName(), "Could not write favorites!", e);
            return;
        }
        prefs(ctx).edit().putString(PREF_KEY, arr.toString()).apply();
    }

    /** Encodes points as [[lat, lng], ...], the format the map page's setRoute() expects. */
    @NonNull
    public static JSONArray encodePoints(@NonNull List<LatLng> points) throws JSONException {
        JSONArray arr = new JSONArray();
        for (LatLng p : points)
            arr.put(new JSONArray().put(p.lat()).put(p.lng()));
        return arr;
    }

    @NonNull
    public static List<LatLng> decodePoints(@NonNull JSONArray arr) throws JSONException {
        List<LatLng> points = new ArrayList<>();
        for (int i = 0; i < arr.length(); i++) {
            JSONArray p = arr.getJSONArray(i);
            points.add(new LatLng(p.getDouble(0), p.getDouble(1)));
        }
        return points;
    }

    @NonNull
    private static SharedPreferences prefs(@NonNull Context ctx) {
        return ctx.getSharedPreferences(MainActivity.sharedPrefKey, Context.MODE_PRIVATE);
    }
}
