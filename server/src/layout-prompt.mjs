import { ROOM_LAYOUT_SCHEMA } from "./layout-schema.mjs";

export const ROOM_LAYOUT_PROMPT = `You reconcile 3-5 photos of the same classroom into one square, normalized top-down room map for an Overcooked-style game.

Use every photo together: deduplicate the same furniture visible from different viewpoints and do not invent furniture that is not useful for the play area. Identify the classroom presentation/front area semantically from whiteboards, projector screens, podiums, teaching desks, and the direction of seating. Rotate the complete map so that presentation/front is at the top (y=0). The presentation area should therefore be near the top of the unit square. Return relevant furniture only in objects, including object IDs, types, and whether each has a usable surface. Place playArea over the usable open floor.

All geometry is in a square unit coordinate system: x and y increase right and down; every point is between 0 and 1. Every rectangle uses center {x,y}, width, height, and rotationDeg. rotationDeg is degrees clockwise; rectangles may be rotated. Return exactly one station of each type: pantry, fridge, cutting_board, and stove. A station may reference the furniture object that supports it with supportObjectId, or null if no supporting object is appropriate.

Output JSON only. Do not return prose, markdown, measurements, aspect-ratio fields, image URLs, tools, or any properties not in the schema.`;

export function layoutResponsesRequest(images) {
  return {
    model: "gpt-5.6-luna",
    store: false,
    reasoning: { effort: "low" },
    instructions: ROOM_LAYOUT_PROMPT,
    input: [{
      role: "user",
      content: images.map(({ mime, bytes }) => ({
        type: "input_image",
        image_url: `data:${mime || "image/jpeg"};base64,${Buffer.from(bytes).toString("base64")}`,
        detail: "low",
      })),
    }],
    text: {
      format: {
        type: "json_schema",
        name: "room_layout",
        strict: true,
        schema: ROOM_LAYOUT_SCHEMA,
      },
    },
  };
}
