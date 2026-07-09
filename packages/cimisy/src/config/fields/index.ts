import { blockTypes } from "../../mdx/block-registry.js";
import { array } from "./array.js";
import { blocksField } from "./blocks.js";
import { date } from "./date.js";
import { image } from "./image.js";
import { slug } from "./slug.js";
import { text } from "./text.js";

export const fields = {
  text,
  date,
  slug,
  image,
  array,
  blocks: blocksField,
};

export const blocks = blockTypes;

export type { BlockDefinition, BlockNode, BlocksFieldDefinition } from "./blocks.js";
export type { FieldDefinition, FieldLocation, InferField } from "./types.js";
