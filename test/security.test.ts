import { describe, expect, it } from "vitest";
import {
  cookieName,
  fetchSiteAllowed,
  hostAllowed,
  originAllowed,
  parseCookies,
  tokensEqual,
} from "../src/server/security.js";
import { send, testServer } from "./helpers.js";

describe("security checks", () => {
  it("accepts only loopback Host headers on our port", () => {
    expect(hostAllowed("127.0.0.1:5417", 5417)).toBe(true);
    expect(hostAllowed("localhost:5417", 5417)).toBe(true);
    expect(hostAllowed("LOCALHOST:5417", 5417)).toBe(true);
    expect(hostAllowed("evil.example:5417", 5417)).toBe(false);
    expect(hostAllowed("127.0.0.1:9999", 5417)).toBe(false);
    expect(hostAllowed("127.0.0.1", 5417)).toBe(false);
    expect(hostAllowed(undefined, 5417)).toBe(false);
  });

  it("accepts a missing Origin or our own, nothing else", () => {
    expect(originAllowed(undefined, 5417)).toBe(true);
    expect(originAllowed("http://127.0.0.1:5417", 5417)).toBe(true);
    expect(originAllowed("http://localhost:5417", 5417)).toBe(true);
    expect(originAllowed("http://127.0.0.1:3000", 5417)).toBe(false);
    expect(originAllowed("https://evil.example", 5417)).toBe(false);
    expect(originAllowed("null", 5417)).toBe(false);
  });

  it("allows only same-origin or user-initiated fetches", () => {
    expect(fetchSiteAllowed(undefined)).toBe(true);
    expect(fetchSiteAllowed("same-origin")).toBe(true);
    expect(fetchSiteAllowed("none")).toBe(true);
    expect(fetchSiteAllowed("same-site")).toBe(false);
    expect(fetchSiteAllowed("cross-site")).toBe(false);
  });

  it("compares tokens exactly", () => {
    expect(tokensEqual("abc", "abc")).toBe(true);
    expect(tokensEqual("abd", "abc")).toBe(false);
    expect(tokensEqual("ab", "abc")).toBe(false);
    expect(tokensEqual(undefined, "abc")).toBe(false);
  });

  it("parses cookies", () => {
    expect(parseCookies("a=1; cutline_5417=tok%20en; b").get("cutline_5417")).toBe("tok en");
  });
});

describe("server request checks", () => {
  it("refuses a foreign Host header (DNS rebinding)", async () => {
    const server = await testServer();
    const res = await send(server.port, {
      path: "/api/info",
      headers: { Host: `rebind.example:${server.port}`, "X-Cutline-Token": server.token },
    });
    expect(res.status).toBe(421);
    expect(res.json().error).toMatchObject({ code: "bad-host" });
  });

  it("refuses API and media requests without the token", async () => {
    const server = await testServer();
    expect((await send(server.port, { path: "/api/info" })).status).toBe(401);
    expect((await send(server.port, { path: "/api/info", headers: { "X-Cutline-Token": "wrong" } })).status).toBe(
      401,
    );
    expect((await send(server.port, { path: "/media/prj_x/a.mp4" })).status).toBe(401);
    const ok = await send(server.port, { path: "/api/info", headers: { "X-Cutline-Token": server.token } });
    expect(ok.status).toBe(200);
    expect(ok.json()).toMatchObject({ name: "cutline", port: server.port });
  });

  it("refuses cross-origin and cross-site requests even with the token", async () => {
    const server = await testServer();
    const token = { "X-Cutline-Token": server.token };
    const crossOrigin = await send(server.port, {
      method: "POST",
      path: "/api/projects",
      body: { name: "Evil" },
      headers: { ...token, Origin: "https://evil.example" },
    });
    expect(crossOrigin.status).toBe(403);
    const crossSite = await send(server.port, {
      path: "/api/projects/recent",
      headers: { ...token, "Sec-Fetch-Site": "cross-site" },
    });
    expect(crossSite.status).toBe(403);
    const sameOrigin = await send(server.port, {
      path: "/api/projects/recent",
      headers: { ...token, Origin: `http://127.0.0.1:${server.port}`, "Sec-Fetch-Site": "same-origin" },
    });
    expect(sameOrigin.status).toBe(200);
  });

  it("turns the launch link into a SameSite=Strict session cookie", async () => {
    const server = await testServer();
    const launch = await send(server.port, { path: `/?token=${encodeURIComponent(server.token)}` });
    expect(launch.status).toBe(302);
    expect(launch.headers.location).toBe("/");
    const cookie = String(launch.headers["set-cookie"]);
    expect(cookie).toContain(`${cookieName(server.port)}=`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    const withCookie = await send(server.port, {
      path: "/api/info",
      headers: { Cookie: cookie.split(";")[0] as string },
    });
    expect(withCookie.status).toBe(200);
  });

  it("rejects an out-of-date launch link", async () => {
    const server = await testServer();
    const res = await send(server.port, { path: "/?token=stale" });
    expect(res.status).toBe(403);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });
});
