import { blocks, collection, config, fields, page, section, singleton } from "cimisy/config";
import { localSource } from "cimisy/adapters/local";
import { seoSettingsFields } from "cimisy/seo";

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
        coverImage: fields.image({ label: "Cover image", directory: "posts/uploads" }),
        seo: fields.seo({ imageDirectory: "posts/uploads" }),
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

  // A singleton is one fixed file — site-wide settings, editable in the
  // admin like any other content. seoSettingsFields() is the conventional
  // schema the cimisy/seo helpers understand (spread your own fields in
  // alongside if you need more).
  singletons: {
    settings: singleton({
      label: "Site settings",
      path: "settings.yaml",
      schema: { ...seoSettingsFields({ imageDirectory: "posts/uploads" }) },
    }),
  },

  // A page groups the content that renders on one route: static sections
  // (one file each) and repeating collections. The admin mirrors this
  // hierarchy, and the reader exposes it as reader.pages.home.*.
  pages: {
    home: page({
      label: "Home",
      path: "pages/home",
      route: "/",
      sections: {
        hero: section({
          label: "Hero",
          schema: {
            heading: fields.text({ label: "Heading", validation: { isRequired: true } }),
            tagline: fields.text({ label: "Tagline" }),
          },
        }),
        testimonials: collection({
          label: "Testimonials",
          slugField: "slug",
          schema: {
            quote: fields.text({ label: "Quote", validation: { isRequired: true } }),
            author: fields.text({ label: "Author" }),
            slug: fields.slug({ source: "author" }),
          },
        }),
      },
    }),
  },
});
