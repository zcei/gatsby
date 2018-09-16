// @flow
const _ = require(`lodash`)
const {
  GraphQLObjectType,
  GraphQLNonNull,
  GraphQLID,
  GraphQLList,
} = require(`graphql`)
const tracer = require(`opentracing`).globalTracer()

const apiRunner = require(`../utils/api-runner-node`)
const { inferObjectStructureFromNodes } = require(`./infer-graphql-type`)
const {
  inferInputObjectStructureFromFields,
} = require(`./infer-graphql-input-fields-from-fields`)
const {
  inferInputObjectStructureFromNodes,
} = require(`./infer-graphql-input-fields`)
const { nodeInterface } = require(`./node-interface`)
const { getNodes, getNode, getNodeAndSavePathDependency } = require(`../redux`)
const { createPageDependency } = require(`../redux/actions/add-page-dependency`)
const { setFileNodeRootType } = require(`./types/type-file`)
const { clearTypeExampleValues } = require(`./data-tree-utils`)

import type { ProcessedNodeType } from "./infer-graphql-type"

const internalTypesSymbol = Symbol(`processedInternalTypes`)

type TypeMap = {
  [typeName: string]: ProcessedNodeType
} & { [typeof internalTypesSymbol]: { [typeName: string]: ProcessedNodeType } }

const nodesCache = new Map()

module.exports = async ({ parentSpan }) => {
  const spanArgs = parentSpan ? { childOf: parentSpan } : {}
  const span = tracer.startSpan(`build schema`, spanArgs)

  const allNodes = getNodes()

  const internalNodes = _.filter(allNodes, (node) => (
    node.internal && node.internal.ignoreType
  ))

  const internalTypeKeys = Object.keys(_.groupBy(
    internalNodes,
    node => _.camelCase(node.internal.type)
  ))

  const types = _.groupBy(
    allNodes,
    node => node.internal.type
  )

  let processedTypes: TypeMap = {}

  clearTypeExampleValues()

  // Reset stored File type to not point to outdated type definition
  setFileNodeRootType(null)

  function createNodeFields(type: ProcessedNodeType) {
    const defaultNodeFields = {
      id: {
        type: new GraphQLNonNull(GraphQLID),
        description: `The id of this node.`,
      },
      parent: {
        type: nodeInterface,
        description: `The parent of this node.`,
        resolve(node, a, context) {
          return getNodeAndSavePathDependency(node.parent, context.path)
        },
      },
      children: {
        type: new GraphQLList(nodeInterface),
        description: `The children of this node.`,
        resolve(node, a, { path }) {
          return node.children.map(id => getNodeAndSavePathDependency(id, path))
        },
      },
    }

    // Create children fields for each type of children e.g.
    // "childrenMarkdownRemark".
    const childNodesByType = _(type.nodes)
      .flatMap(({ children }) => children.map(getNode))
      .groupBy(
        node => (node.internal ? _.camelCase(node.internal.type) : undefined)
      )
      .value()

    Object.keys(childNodesByType).forEach(childNodeType => {
      // Does this child type have one child per parent or multiple?
      const maxChildCount = _.maxBy(
        _.values(_.groupBy(childNodesByType[childNodeType], c => c.parent)),
        g => g.length
      ).length

      if (maxChildCount > 1) {
        defaultNodeFields[_.camelCase(`children ${childNodeType}`)] = {
          type: new GraphQLList((processedTypes[childNodeType] || processedTypes[internalTypesSymbol][childNodeType]).nodeObjectType),
          description: `The children of this node of type ${childNodeType}`,
          resolve(node, a, { path }) {
            const filteredNodes = node.children
              .map(id => getNode(id))
              .filter(
                ({ internal }) => _.camelCase(internal.type) === childNodeType
              )

            // Add dependencies for the path
            filteredNodes.forEach(n =>
              createPageDependency({
                path,
                nodeId: n.id,
              })
            )
            return filteredNodes
          },
        }
      } else {
        // console.log(_.map(type.nodes, `internal`))
        console.log(childNodeType)
        console.dir(type.nodes, { colors: true, depth: 5 })
        defaultNodeFields[_.camelCase(`child ${childNodeType}`)] = {
          type: (processedTypes[childNodeType] || processedTypes[internalTypesSymbol][childNodeType]).nodeObjectType,
          description: `The child of this node of type ${childNodeType}`,
          resolve(node, a, { path }) {
            const childNode = node.children
              .map(id => getNode(id))
              .find(
                ({ internal }) => _.camelCase(internal.type) === childNodeType
              )

            if (childNode) {
              console.log(`child node`)
              console.log(childNode)
              // Add dependencies for the path
              createPageDependency({
                path,
                nodeId: childNode.id,
              })
              return childNode
            }
            return null
          },
        }
      }
    })

    const inferredFields = inferObjectStructureFromNodes({
      nodes: type.nodes,
      types: _.values(processedTypes),
      ignoreFields: Object.keys(type.fieldsFromPlugins),
    })

    return {
      ...defaultNodeFields,
      ...inferredFields,
      ...type.fieldsFromPlugins,
    }
  }

  async function createType(nodes, typeName) {
    const intermediateType = {}

    intermediateType.name = typeName
    intermediateType.nodes = nodes

    const fieldsFromPlugins = await apiRunner(`setFieldsOnGraphQLNodeType`, {
      type: intermediateType,
      traceId: `initial-setFieldsOnGraphQLNodeType`,
      parentSpan: span,
    })

    const mergedFieldsFromPlugins = _.merge(...fieldsFromPlugins)

    // if (Object.keys(mergedFieldsFromPlugins).length) {
    //   console.log(`mergedFieldsFromPlugins`, typeName)
    //   console.dir(mergedFieldsFromPlugins, { colors: true, depth: 4 })
    // }

    const inferredInputFieldsFromPlugins = inferInputObjectStructureFromFields({
      fields: mergedFieldsFromPlugins,
    })

    const gqlType = new GraphQLObjectType({
      name: typeName,
      description: `Node of type ${typeName}`,
      interfaces: [nodeInterface],
      fields: () => createNodeFields(proccesedType),
      isTypeOf: value => value.internal.type === typeName,
    })

    const inferedInputFields = inferInputObjectStructureFromNodes({
      nodes,
      typeName,
    })

    const filterFields = _.merge(
      {},
      inferedInputFields.inferredFields,
      inferredInputFieldsFromPlugins.inferredFields
    )

    const proccesedType: ProcessedNodeType = {
      ...intermediateType,
      fieldsFromPlugins: mergedFieldsFromPlugins,
      nodeObjectType: gqlType,
      node: {
        name: typeName,
        type: gqlType,
        args: filterFields,
        resolve(a, args, context) {
          const runSift = require(`./run-sift`)
          let latestNodes
          if (
            process.env.NODE_ENV === `production` &&
            nodesCache.has(typeName)
          ) {
            latestNodes = nodesCache.get(typeName)
          } else {
            latestNodes = _.filter(
              getNodes(),
              n => n.internal.type === typeName
            )
            nodesCache.set(typeName, latestNodes)
          }
          if (!_.isObject(args)) {
            args = {}
          }
          return runSift({
            args: {
              filter: {
                ...args,
              },
            },
            nodes: latestNodes,
            path: context.path ? context.path : ``,
            typeName: typeName,
            type: gqlType,
          })
        },
      },
    }

    // TODO: only add if nodes filtered by ignoretype are not empty
    processedTypes[_.camelCase(typeName)] = proccesedType

    // Special case to construct linked file type used by type inferring
    if (typeName === `File`) {
      setFileNodeRootType(gqlType)
    }
  }

  // Create node types and node fields for nodes that have a resolve function.
  await Promise.all(_.map(types, createType))


  processedTypes[internalTypesSymbol] = {}
  _.each(internalTypeKeys, (key) => {
    const internalType = processedTypes[key]
    delete processedTypes[key]
    processedTypes[internalTypesSymbol][key] = internalType
  })

  span.finish()

  return processedTypes
}

module.exports.internalTypesSymbol = internalTypesSymbol
