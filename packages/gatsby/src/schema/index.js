/* @flow */
const _ = require(`lodash`)
const { GraphQLSchema, GraphQLObjectType, printSchema } = require(`graphql`)
const { mergeSchemas } = require(`graphql-tools`)

const buildNodeTypes = require(`./build-node-types`)
const buildNodeConnections = require(`./build-node-connections`)
const { store, getNode } = require(`../redux`)
const invariant = require(`invariant`)

const { internalTypesSymbol } = buildNodeTypes

module.exports = async ({ parentSpan }) => {
  // const internalTypesGQL = await buildNodeTypes({ parentSpan, internalIgnoreTypes: true })
  // console.log(`done creating internalTypes`)
  // console.log(Object.keys(internalTypesGQL))
  const typesGQL = await buildNodeTypes({ parentSpan })
  const connections = buildNodeConnections(_.values(typesGQL))

  for (const [fieldName, field] of Object.entries(typesGQL[internalTypesSymbol])) {
    console.log(`internal / shadow type`)
    console.log(fieldName)
    console.log(field.fieldsFromPlugins)
    console.log(field.node.type)
    console.dir(field, { colors: true, depth: 5 })
  }

  // console.log(`fooooo`)
  // console.log(getNode(`5ff1df72-c03d-5019-8c0e-bd6b50d283f1`))

  // const foo = Object.keys(typesGQL)//.filter((node) => (node.nodes || []).includes(`emark`)).map((key) => typesGQL[key])
  // console.log(typesGQL[`markdownRemark`])

  // Pull off just the graphql node from each type object.
  const nodes = _.mapValues(typesGQL, `node`)
  const shadowNodes = _.mapValues(typesGQL[internalTypesSymbol], `node`)
  const shadowConnections = buildNodeConnections(_.values(typesGQL[internalTypesSymbol]))

  invariant(!_.isEmpty(nodes), `There are no available GQL nodes`)
  invariant(!_.isEmpty(connections), `There are no available GQL connections`)

  const thirdPartySchemas = store.getState().thirdPartySchemas || []

  const gatsbySchema = new GraphQLSchema({
    query: new GraphQLObjectType({
      name: `RootQueryType`,
      fields: { ...connections, ...nodes },
    }),
  })

  const shadowSchema = new GraphQLSchema({
    query: new GraphQLObjectType({
      name: `RootQueryType`,
      fields: { ...shadowConnections, ...shadowNodes },
    }),
  })

  const [contentfulSchema] = thirdPartySchemas

  // console.log(printSchema(contentfulSchema))

  // for (const thirdPartySchema of thirdPartySchemas) {
  //   console.log(printSchema(thirdPartySchema))
  // }

  const linkTypeDefs = `
    extend type Contentful_BlogPost {
      bodyMarkdown: MarkdownRemarkDPF
    }
  `


  function directivePluginsFields (shadowNode, processedType) {
    const name = `${shadowNode.internal.type}DPF` // DirectivePluginFields`

    const shadowNodeType = new GraphQLObjectType({
      name,
      fields: processedType.fieldsFromPlugins,
    })

    return {
      name,
      type: shadowNodeType,
      resolve: (root) => root.runtimeNode,
    }
  }

  // TODO: do that for all shadow node children
  // do it via children from directive node
  const childMarkdownRemarkType = directivePluginsFields(makeRuntimeNode({ body: `* placeholder` }).runtimeNode, typesGQL.markdownRemark)
  const directiveNodeSchema = new GraphQLSchema({
    query: new GraphQLObjectType({
      name: `RootQueryTypeDPF`,
      fields: {
        childMarkdownRemark: childMarkdownRemarkType,
        // and potentially more, e.g. sharp
      },
    }),
  })

  function makeRuntimeNode (root) {
    // const stub = {
    //   id: `20f14722-0271-5a84-b1ec-bac1479bff4f`,
    //   parent: `d5ee1bba-5db0-5c0c-8198-a60e35f1734b`,
    //   children: [`5ff1df72-c03d-5019-8c0e-bd6b50d283f1`],
    //   internal:
    //   {
    //     type: `graphQlSourceContentfulBlogPostTextNode`,
    //     mediaType: `text/markdown`,
    //     content: root.body,
    //     contentDigest: `${Math.random()}bf973c6beb9f58c4ee94ddd44e604356`,
    //     ignoreType: true,
    //     owner: `gatsby-transformer-directives`,
    //   },
    // }

    const stub = {
      id: `5ff1df72-c03d-5019-8c0e-bd6b50d283f1`,
      children: [],
      parent: `20f14722-0271-5a84-b1ec-bac1479bff4f`,
      internal: {
        content: root.body,
        type: `MarkdownRemark`,
        contentDigest: `${Math.random()}0aa620dfc373017a64d9f4204adf1990`,
        owner: `gatsby-transformer-remark`,
      },
      frontmatter: { title: ``, _PARENT: `20f14722-0271-5a84-b1ec-bac1479bff4f` },
      excerpt: ``,
      rawMarkdownBody: root.body,
    }

    return {
      runtimeNode: stub,
    }
  }

  // console.log(`runtime schema`)
  // console.log(printSchema(runtimeSchema))
  // console.log(`directive node schema`)
  // console.log(printSchema(directiveNodeSchema))

  const adt = {
    typeName: `Contentful_BlogPost`,
    fieldName: `bodyMarkdown`,
    createRuntimeNode: makeRuntimeNode,
    fragmentFields: [`body`],
  }

  const schema = mergeSchemas({
    schemas: [gatsbySchema, ...thirdPartySchemas, shadowSchema, directiveNodeSchema, linkTypeDefs],
    resolvers: {
      // every type / field annotated with a directive needs to
      // add the proper resolvers here delegating to the directive schema
      Contentful_BlogPost: {
        bodyMarkdown: {
          fragment: `... on Contentful_BlogPost { body }`,
          async resolve (parent, args, context, info) {
            const runtimeNode = makeRuntimeNode(parent)

            const foo = await info.mergeInfo.delegateToSchema({
              schema: directiveNodeSchema,
              operation: `query`,
              fieldName: `childMarkdownRemark`,
              context,
              info: {
                ...info,
                rootValue: runtimeNode,
              },
            })

            return foo
          },
        },
      },
    },
  })

  store.dispatch({
    type: `SET_SCHEMA`,
    payload: schema,
  })
}
