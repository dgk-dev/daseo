import { describe, expect, it, vi } from "vitest";
import { submitAgentInput } from "./submit";

function createDeferredPromise<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return {
    promise,
    resolve,
    reject,
  };
}

describe("submitAgentInput", () => {
  it("clears the composer before an in-flight submit resolves", async () => {
    const deferred = createDeferredPromise<void>();
    const queueMessage = vi.fn();
    const submitMessage = vi.fn(async () => {
      await deferred.promise;
    });
    const clearDraft = vi.fn();
    const setUserInput = vi.fn();
    const setAttachments = vi.fn();
    const setSendError = vi.fn();
    const setIsProcessing = vi.fn();

    const submitPromise = submitAgentInput({
      message: "  hello world  ",
      attachments: [],
      isAgentRunning: false,
      canSubmit: true,
      queueMessage,
      submitMessage,
      clearDraft,
      setUserInput,
      setAttachments,
      setSendError,
      setIsProcessing,
      readCurrentDraft: () => ({ text: "", attachments: [] }),
      keepFailedSubmission: vi.fn(),
    });

    expect(queueMessage).not.toHaveBeenCalled();
    expect(submitMessage).toHaveBeenCalledWith({
      message: "hello world",
      attachments: [],
    });
    expect(setUserInput).toHaveBeenCalledWith("");
    expect(setAttachments).toHaveBeenCalledWith([]);
    expect(setSendError).toHaveBeenCalledWith(null);
    expect(setIsProcessing).toHaveBeenCalledWith(true);
    expect(clearDraft).not.toHaveBeenCalled();

    deferred.resolve();

    await expect(submitPromise).resolves.toBe("submitted");
    expect(clearDraft).toHaveBeenCalledWith("sent");
  });

  it("preserves the composer before an in-flight submit resolves when requested", async () => {
    const deferred = createDeferredPromise<void>();
    const attachments = [{ id: "img-1" }];
    const queueMessage = vi.fn();
    const submitMessage = vi.fn(async () => {
      await deferred.promise;
    });
    const clearDraft = vi.fn();
    const setUserInput = vi.fn();
    const setAttachments = vi.fn();
    const setSendError = vi.fn();
    const setIsProcessing = vi.fn();

    const submitPromise = submitAgentInput({
      message: "  keep me  ",
      attachments,
      submitBehavior: "preserve-and-lock",
      isAgentRunning: false,
      canSubmit: true,
      queueMessage,
      submitMessage,
      clearDraft,
      setUserInput,
      setAttachments,
      setSendError,
      setIsProcessing,
      readCurrentDraft: () => ({ text: "  keep me  ", attachments }),
      keepFailedSubmission: vi.fn(),
    });

    expect(queueMessage).not.toHaveBeenCalled();
    expect(submitMessage).toHaveBeenCalledWith({
      message: "keep me",
      attachments,
    });
    expect(setUserInput).not.toHaveBeenCalled();
    expect(setAttachments).not.toHaveBeenCalled();
    expect(setSendError).toHaveBeenCalledWith(null);
    expect(setIsProcessing).toHaveBeenCalledWith(true);
    expect(clearDraft).not.toHaveBeenCalled();

    deferred.resolve();

    await expect(submitPromise).resolves.toBe("submitted");
    expect(clearDraft).toHaveBeenCalledWith("sent");
  });

  it("queues while the agent is running and clears the composer immediately", async () => {
    const queueMessage = vi.fn();
    const submitMessage = vi.fn();
    const clearDraft = vi.fn();
    const setUserInput = vi.fn();
    const setAttachments = vi.fn();
    const setSendError = vi.fn();
    const setIsProcessing = vi.fn();

    await expect(
      submitAgentInput({
        message: "  queued message  ",
        attachments: [{ id: "img-1" }],
        isAgentRunning: true,
        canSubmit: true,
        queueMessage,
        submitMessage,
        clearDraft,
        setUserInput,
        setAttachments,
        setSendError,
        setIsProcessing,
        readCurrentDraft: () => ({ text: "  queued message  ", attachments: [{ id: "img-1" }] }),
        keepFailedSubmission: vi.fn(),
      }),
    ).resolves.toBe("queued");

    expect(queueMessage).toHaveBeenCalledWith({
      message: "queued message",
      attachments: [{ id: "img-1" }],
    });
    expect(submitMessage).not.toHaveBeenCalled();
    expect(setUserInput).toHaveBeenCalledWith("");
    expect(setAttachments).toHaveBeenCalledWith([]);
    expect(setSendError).not.toHaveBeenCalled();
    expect(setIsProcessing).not.toHaveBeenCalled();
    expect(clearDraft).not.toHaveBeenCalled();
  });

  it("keeps the composer intact when durable queue persistence fails", async () => {
    const queueError = new Error("outbox unavailable");
    const queueMessage = vi.fn(async () => {
      throw queueError;
    });
    const setUserInput = vi.fn();
    const setAttachments = vi.fn();
    const setSendError = vi.fn();
    const onSubmitError = vi.fn();

    await expect(
      submitAgentInput({
        message: "  queued message  ",
        attachments: [{ id: "img-1" }],
        isAgentRunning: true,
        canSubmit: true,
        queueMessage,
        submitMessage: vi.fn(),
        clearDraft: vi.fn(),
        setUserInput,
        setAttachments,
        setSendError,
        setIsProcessing: vi.fn(),
        readCurrentDraft: () => ({ text: "", attachments: [] }),
        keepFailedSubmission: vi.fn(),
        onSubmitError,
      }),
    ).resolves.toBe("failed");

    expect(onSubmitError).toHaveBeenCalledWith(queueError);
    expect(setUserInput).not.toHaveBeenCalled();
    expect(setAttachments).not.toHaveBeenCalled();
    expect(setSendError).toHaveBeenCalledWith("outbox unavailable");
  });

  it("restores the composer when submit fails", async () => {
    const submitError = new Error("No host selected");
    const queueMessage = vi.fn();
    const submitMessage = vi.fn(async () => {
      throw submitError;
    });
    const clearDraft = vi.fn();
    const setUserInput = vi.fn();
    const setAttachments = vi.fn();
    const setSendError = vi.fn();
    const setIsProcessing = vi.fn();
    const onSubmitError = vi.fn();
    const attachments = [{ id: "img-1" }];

    await expect(
      submitAgentInput({
        message: "  hello world  ",
        attachments,
        isAgentRunning: false,
        canSubmit: true,
        queueMessage,
        submitMessage,
        clearDraft,
        setUserInput,
        setAttachments,
        setSendError,
        setIsProcessing,
        readCurrentDraft: () => ({ text: "", attachments: [] }),
        keepFailedSubmission: vi.fn(),
        onSubmitError,
      }),
    ).resolves.toBe("failed");

    expect(onSubmitError).toHaveBeenCalledWith(submitError);
    expect(setUserInput).toHaveBeenNthCalledWith(1, "");
    expect(setUserInput).toHaveBeenNthCalledWith(2, "hello world");
    expect(setAttachments).toHaveBeenNthCalledWith(1, []);
    expect(setAttachments).toHaveBeenNthCalledWith(2, attachments);
    expect(setSendError).toHaveBeenNthCalledWith(1, null);
    expect(setSendError).toHaveBeenNthCalledWith(2, "No host selected");
    expect(setIsProcessing).toHaveBeenNthCalledWith(1, true);
    expect(setIsProcessing).toHaveBeenNthCalledWith(2, false);
    expect(clearDraft).not.toHaveBeenCalled();
  });

  it("submits when empty submit is explicitly allowed", async () => {
    const queueMessage = vi.fn();
    const submitMessage = vi.fn(async () => {});
    const clearDraft = vi.fn();
    const setUserInput = vi.fn();
    const setAttachments = vi.fn();
    const setSendError = vi.fn();
    const setIsProcessing = vi.fn();

    await expect(
      submitAgentInput({
        message: "   ",
        attachments: [],
        allowEmptySubmit: true,
        isAgentRunning: false,
        canSubmit: true,
        queueMessage,
        submitMessage,
        clearDraft,
        setUserInput,
        setAttachments,
        setSendError,
        setIsProcessing,
        readCurrentDraft: () => ({ text: "", attachments: [] }),
        keepFailedSubmission: vi.fn(),
      }),
    ).resolves.toBe("submitted");

    expect(queueMessage).not.toHaveBeenCalled();
    expect(submitMessage).toHaveBeenCalledWith({
      message: "",
      attachments: [],
    });
    expect(clearDraft).toHaveBeenCalledWith("sent");
  });

  function createDraftModel(initial: { text: string; attachments: Array<{ id: string }> }) {
    const draft = { text: initial.text, attachments: [...initial.attachments] };
    return {
      draft,
      setUserInput: vi.fn((text: string) => {
        draft.text = text;
      }),
      setAttachments: vi.fn((attachments: Array<{ id: string }>) => {
        draft.attachments = [...attachments];
      }),
      readCurrentDraft: () => ({ text: draft.text, attachments: [...draft.attachments] }),
    };
  }

  it("keeps text typed during an in-flight send when the send succeeds", async () => {
    const deferred = createDeferredPromise<void>();
    const model = createDraftModel({ text: "first", attachments: [] });
    const clearDraft = vi.fn();

    const submitPromise = submitAgentInput({
      message: "first",
      attachments: [],
      isAgentRunning: false,
      canSubmit: true,
      queueMessage: vi.fn(),
      submitMessage: async () => deferred.promise,
      clearDraft,
      setUserInput: model.setUserInput,
      setAttachments: model.setAttachments,
      readCurrentDraft: model.readCurrentDraft,
      keepFailedSubmission: vi.fn(),
      setSendError: vi.fn(),
      setIsProcessing: vi.fn(),
    });
    expect(model.draft.text).toBe("");
    model.draft.text = "typed while sending";
    model.draft.attachments = [{ id: "img-new" }];

    deferred.resolve();
    await expect(submitPromise).resolves.toBe("submitted");

    expect(clearDraft).not.toHaveBeenCalled();
    expect(model.draft).toEqual({ text: "typed while sending", attachments: [{ id: "img-new" }] });
  });

  it("keeps newer input and the failed message when an in-flight send fails", async () => {
    const deferred = createDeferredPromise<void>();
    const model = createDraftModel({ text: "first", attachments: [{ id: "img-old" }] });
    const keepFailedSubmission = vi.fn();
    const setSendError = vi.fn();

    const submitPromise = submitAgentInput({
      message: "first",
      attachments: [{ id: "img-old" }],
      isAgentRunning: false,
      canSubmit: true,
      queueMessage: vi.fn(),
      submitMessage: async () => deferred.promise,
      clearDraft: vi.fn(),
      setUserInput: model.setUserInput,
      setAttachments: model.setAttachments,
      readCurrentDraft: model.readCurrentDraft,
      keepFailedSubmission,
      setSendError,
      setIsProcessing: vi.fn(),
    });
    model.draft.text = "typed while sending";

    deferred.reject(new Error("Host went away"));
    await expect(submitPromise).resolves.toBe("failed");

    expect(model.draft).toEqual({ text: "typed while sending", attachments: [] });
    expect(keepFailedSubmission).toHaveBeenCalledWith({
      message: "first",
      attachments: [{ id: "img-old" }],
    });
    expect(setSendError).toHaveBeenLastCalledWith("Host went away");
  });

  it("restores the failed message into an untouched empty draft", async () => {
    const model = createDraftModel({ text: "first", attachments: [] });
    const keepFailedSubmission = vi.fn();

    await submitAgentInput({
      message: "first",
      attachments: [],
      isAgentRunning: false,
      canSubmit: true,
      queueMessage: vi.fn(),
      submitMessage: async () => {
        throw new Error("nope");
      },
      clearDraft: vi.fn(),
      setUserInput: model.setUserInput,
      setAttachments: model.setAttachments,
      readCurrentDraft: model.readCurrentDraft,
      keepFailedSubmission,
      setSendError: vi.fn(),
      setIsProcessing: vi.fn(),
    });

    expect(model.draft.text).toBe("first");
    expect(keepFailedSubmission).not.toHaveBeenCalled();
  });

  it("keeps text typed while a queue write is pending", async () => {
    const deferred = createDeferredPromise<void>();
    const model = createDraftModel({ text: "queued", attachments: [{ id: "img-q" }] });

    const submitPromise = submitAgentInput({
      message: "queued",
      attachments: [{ id: "img-q" }],
      isAgentRunning: true,
      canSubmit: true,
      queueMessage: async () => deferred.promise,
      submitMessage: vi.fn(),
      clearDraft: vi.fn(),
      setUserInput: model.setUserInput,
      setAttachments: model.setAttachments,
      readCurrentDraft: model.readCurrentDraft,
      keepFailedSubmission: vi.fn(),
      setSendError: vi.fn(),
      setIsProcessing: vi.fn(),
    });
    model.draft.text = "queued and more";

    deferred.resolve();
    await expect(submitPromise).resolves.toBe("queued");

    expect(model.draft).toEqual({ text: "and more", attachments: [] });
  });
});
