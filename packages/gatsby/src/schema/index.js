/* @flow */
const _ = require(`lodash`)
const { GraphQLSchema, GraphQLObjectType } = require(`graphql`)
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
    console.log(fieldName)
    console.log(field.node.type)
    console.log(field.nodes)
  }

  console.log(`fooooo`)
  console.log(getNode(`5ff1df72-c03d-5019-8c0e-bd6b50d283f1`))

  const foo = Object.keys(typesGQL)//.filter((node) => (node.nodes || []).includes(`emark`)).map((key) => typesGQL[key])
  console.log(typesGQL[`markdownRemark`])

  // Pull off just the graphql node from each type object.
  const nodes = _.mapValues(typesGQL, `node`)

  invariant(!_.isEmpty(nodes), `There are no available GQL nodes`)
  invariant(!_.isEmpty(connections), `There are no available GQL connections`)

  const thirdPartySchemas = store.getState().thirdPartySchemas || []

  const gatsbySchema = new GraphQLSchema({
    query: new GraphQLObjectType({
      name: `RootQueryType`,
      fields: { ...connections, ...nodes },
    }),
  })

  const schema = mergeSchemas({
    schemas: [gatsbySchema, ...thirdPartySchemas],
  })

  store.dispatch({
    type: `SET_SCHEMA`,
    payload: schema,
  })
}
