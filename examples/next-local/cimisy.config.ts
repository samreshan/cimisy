import { blocks, collection, config, fields } from "cimisy/config";
import { localSource } from "cimisy/adapters/local";

export default config({
  source: localSource({ rootDir: "./content" }),

  collections: {
    posts: collection({
      label: "Blog posts",
      path: "posts/*.mdx",
      slugField: "slug",
      previewPath: "/blog/:slug",
      schema: {
        title: fields.text({ label: "Title", validation: { isRequired: true } }),
        slug: fields.slug({ source: "title" }),
        publishedAt: fields.date({ label: "Published at" }),
        body: fields.blocks({
          label: "Body",
          blocks: {
            heading: blocks.heading(),
            paragraph: blocks.paragraph(),
            image: blocks.image(),
            callout: blocks.callout({ tones: ["info", "warning", "danger"] }),
            code: blocks.code({ languages: ["ts", "js", "bash", "json"] }),
          },
        }),
      },
    }),
  },
});
