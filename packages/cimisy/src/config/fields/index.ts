import { blockTypes } from "../../mdx/block-registry.js";
import { array } from "./array.js";
import { blocksField } from "./blocks.js";
import { boolean } from "./boolean.js";
import { date } from "./date.js";
import { image } from "./image.js";
import { number } from "./number.js";
import { select } from "./select.js";
import { seo } from "./seo.js";
import { slug } from "./slug.js";
import { text } from "./text.js";

export const fields = {
  text,
  boolean,
  number,
  select,
  date,
  slug,
  image,
  array,
  blocks: blocksField,
  seo,
};

export const blocks = blockTypes;

export type { ArrayFieldDefinition } from "./array.js";
export type { BlockDefinition, BlockNode, BlocksFieldDefinition } from "./blocks.js";
export type { BooleanFieldDefinition, BooleanFieldOptions } from "./boolean.js";
export type { NumberFieldDefinition, NumberFieldOptions } from "./number.js";
export type { SelectFieldDefinition, SelectFieldOptions } from "./select.js";
export type { SeoFieldDefinition, SeoFieldOptions, SeoValue } from "./seo.js";
export type { FieldDefinition, FieldLocation, InferField } from "./types.js";
