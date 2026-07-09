import { describe, expect, it } from "vitest";
import { inferSchema } from "../infer-schema.js";

describe("inferSchema", () => {
  it("infers text fields and a slug source from SIA's news article shape", () => {
    const proposal = inferSchema([
      { title: "Sunflower Institute Featured in TechPana", date: "April 2026", category: "Press" },
      { title: "Nepal Needs a Constructive Nationwide System for Autism", date: "March 2026", category: "Advocacy" },
    ]);

    const byName = Object.fromEntries(proposal.fields.map((f) => [f.name, f]));
    expect(byName.title!.proposedKind).toBe("text");
    expect(byName.category!.proposedKind).toBe("text");
    // date-looking values are still proposed as "text" (not a real fields.date()), so the extracted
    // content round-trips byte-for-byte instead of being coerced through a Date object on read.
    expect(byName.date!.proposedKind).toBe("text");
    expect(byName.date!.note).toMatch(/looks like a date/);
    expect(proposal.slugField).toBe("slug");
    expect(proposal.slugSourceField).toBe("title");
  });

  it("infers array-of-text for nested string arrays (SIA's vacancies `requirements`)", () => {
    const proposal = inferSchema([
      { title: "ABA Therapist", requirements: ["Bachelors in Psychology", "Strong communication skills"] },
      { title: "Shadow Teacher", requirements: ["Patience", "Classroom experience"] },
    ]);
    const requirements = proposal.fields.find((f) => f.name === "requirements")!;
    expect(requirements.proposedKind).toBe("array-of-text");
    expect(requirements.sourceKind).toBe("array");
  });

  it("infers an image field from a path-shaped string (SIA's partner `logo`)", () => {
    const proposal = inferSchema([
      { name: "Allora", logo: "/golden carpet/partners/Allora.png" },
      { name: "Codeavatar", logo: "/golden carpet/partners/Codeavatar.png" },
    ]);
    const logo = proposal.fields.find((f) => f.name === "logo")!;
    expect(logo.proposedKind).toBe("image");
    expect(logo.note).toMatch(/directory/);
    // no "title" field present here, falls back to "name"
    expect(proposal.slugSourceField).toBe("name");
  });

  it("marks a field optional when it's missing on some items", () => {
    const proposal = inferSchema([{ title: "A", subtitle: "has one" }, { title: "B" }]);
    const subtitle = proposal.fields.find((f) => f.name === "subtitle")!;
    expect(subtitle.optional).toBe(true);
    const title = proposal.fields.find((f) => f.name === "title")!;
    expect(title.optional).toBe(false);
  });

  it("coerces numbers and booleans to text with an explanatory note", () => {
    const proposal = inferSchema([
      { title: "A", priority: 1, featured: true },
      { title: "B", priority: 2, featured: false },
    ]);
    const priority = proposal.fields.find((f) => f.name === "priority")!;
    expect(priority.proposedKind).toBe("text");
    expect(priority.sourceKind).toBe("number");
    expect(priority.note).toMatch(/numbers/);
    const featured = proposal.fields.find((f) => f.name === "featured")!;
    expect(featured.sourceKind).toBe("boolean");
  });

  it("flags mixed-type values across items rather than guessing", () => {
    const proposal = inferSchema([{ title: "A", value: "text" }, { title: "B", value: 42 }]);
    const value = proposal.fields.find((f) => f.name === "value")!;
    expect(value.proposedKind).toBe("text");
    expect(value.sourceKind).toBe("mixed");
    expect(value.note).toMatch(/inconsistent/);
  });

  it("avoids colliding with a pre-existing 'slug' data key", () => {
    const proposal = inferSchema([{ title: "A", slug: "already-here" }]);
    expect(proposal.slugField).toBe("entrySlug");
  });

  it("falls back to 'heading' or the first text field when no title/name field exists", () => {
    const withHeading = inferSchema([{ heading: "H1", body: "text" }]);
    expect(withHeading.slugSourceField).toBe("heading");

    const withNeither = inferSchema([{ blurb: "B1", tag: "T1" }]);
    expect(["blurb", "tag"]).toContain(withNeither.slugSourceField);
  });
});
