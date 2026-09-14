import { describe, expect, it } from "vitest";
import { badgeFor, makeAddRemoteForm } from "./add-remote-vault";

describe("makeAddRemoteForm", () => {
  it("호스트와 6자리 코드가 모두 유효해야 페어링 버튼이 켜진다", () => {
    const f = makeAddRemoteForm();
    expect(f.canSubmit()).toBe(false);
    f.setHost("wis-macmini");
    f.setCode("12345");
    expect(f.canSubmit()).toBe(false);
    f.setCode("123456");
    expect(f.canSubmit()).toBe(true);
  });

  it("공백만 입력하면 호스트는 비어있는 것으로 취급한다", () => {
    const f = makeAddRemoteForm();
    f.setHost("   ");
    f.setCode("123456");
    expect(f.canSubmit()).toBe(false);
  });

  it("values()가 트림된 현재 입력을 돌려준다", () => {
    const f = makeAddRemoteForm();
    f.setHost(" wis-macmini:9000 ");
    f.setCode(" 654321 ");
    expect(f.values()).toEqual({ host: "wis-macmini:9000", code: "654321" });
  });
});

describe("badgeFor", () => {
  it("연결 상태 4종이 각각 다른 배지로 매핑된다", () => {
    expect(badgeFor("connected")).toEqual({ label: "연결됨", tone: "ok" });
    expect(badgeFor("unreachable")).toEqual({ label: "연결 안 됨", tone: "warn" });
    expect(badgeFor("auth-expired")).toEqual({ label: "인증 만료", tone: "error" });
    expect(badgeFor("sharing-off")).toEqual({ label: "호스트가 공유를 껐음", tone: "warn" });
  });
});
