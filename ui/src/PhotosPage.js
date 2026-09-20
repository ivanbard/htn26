import React from "react";
import { generateRoomLayout } from "./photo.js";

const h = React.createElement;

export async function uploadRoomPhotos(files, { fetchImpl = globalThis.fetch } = {}) {
  const selected = Array.from(files || []);
  if (selected.length < 4 || selected.length > 5) {
    throw new Error("Select 4 or 5 photos of the same room.");
  }
  return generateRoomLayout(fetchImpl, selected);
}

export function PhotosPage({ fetchImpl = globalThis.fetch }) {
  const [status, setStatus] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const onChange = async (event) => {
    const input = event.target;
    const files = Array.from(input.files || []);
    setBusy(true);
    setStatus("Generating room layout…");
    try {
      await uploadRoomPhotos(files, { fetchImpl });
      setStatus("Layout generated. Continue on the laptop.");
    } catch (error) {
      setStatus(`${error.message} You can choose the photos again.`);
    } finally {
      // Clear the picker: the browser does not fire a change event when the same
      // files are chosen again, which would make a retry silently do nothing.
      input.value = "";
      setBusy(false);
    }
  };

  return h("main", { className: "photos-page", "aria-labelledby": "photos-title" },
    h("h1", { id: "photos-title" }, "Room photos"),
    h("p", null, "Select 4 or 5 photos of the same room. They upload as soon as you select them."),
    h("label", { className: "photos-upload", htmlFor: "photos-input" },
      h("span", null, busy ? "Uploading…" : "Choose 4–5 photos"),
      h("input", {
        id: "photos-input",
        type: "file",
        accept: "image/*",
        multiple: true,
        disabled: busy,
        onChange,
      }),
    ),
    status && h("p", { className: "photos-status", role: "status" }, status),
  );
}
