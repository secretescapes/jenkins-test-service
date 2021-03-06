"use strict";
const axios = require("axios");
const AWS = require("aws-sdk");

require("dotenv").config();

const dynamoDbParams = {
  region: "eu-west-1"
};

if (process.env.LOCAL_DYNAMODB_ENDPOINT !== "") {
  dynamoDbParams["endpoint"] = process.env.LOCAL_DYNAMODB_ENDPOINT;
}
const dynamodb = new AWS.DynamoDB(dynamoDbParams);
const lambda = new AWS.Lambda({
  region: "eu-west-1"
});

/**
 * This function is schedule to run hourly, MON-THU (see serverless.yml).
 * It gets the most recent builds in Jenkins and the last builds that were collected,
 * then, it calculates which builds are new in Jenkins and should be collected (max 10).
 * Then, it invokes the collector lambda.
 */
module.exports.triggerScan = async event => {
  try {
    const lastBuilds = await fetchBuildsInfo();
    console.log(JSON.stringify(lastBuilds));
    const mostRecentBuildFetched = Math.max(...(await fetchLastRunBuilds()));
    const buildsToFetch = lastBuilds
      .slice(0, lastBuilds.indexOf(mostRecentBuildFetched))
      .slice(0, 10);
    console.log(`Builds to fetch: ${buildsToFetch}`);
    for (const buildId of buildsToFetch) {
      const params = {
        FunctionName: process.env.COLLECT_LAMBDA_NAME,
        InvocationType: "Event",
        Payload: JSON.stringify({ buildId })
      };
      console.log(`INVOKING: ${JSON.stringify(params)}`);
      await lambda.invoke(params).promise();
    }
    return buildsToFetch;
  } catch (err) {
    console.error(`Error: ${err}`);
  }
};

/**
 * Collects test results and stores information about the failed ones
 * in DynamoDB. This lambda can be invoked from an http request or from
 * another lambda.
 */
module.exports.collectTestResults = async event => {
  console.log(JSON.stringify(event));
  var statusCode;
  var body;
  // The buildId is in a different place if the invokation is from API or another Lambda.
  const buildId = event.pathParameters
    ? event.pathParameters.buildId
    : event.buildId;
  try {
    if (!buildId) {
      return {
        statusCode: 400,
        body: "You have to provide a build id"
      };
    }
    await startLog(buildId);
    const tests = await fetchBuild(buildId);
    if (tests) {
      await storeResults(tests);
    }

    console.log(`Successfuly collected results for ${buildId}`);
    statusCode = 200;
  } catch (err) {
    console.error(`ERROR: ${err}`);
    statusCode = 500;
    body = JSON.stringify(err);
  }
  try {
    await endLog(buildId, "COMPLETED");
  } catch (err) {}
  return {
    statusCode,
    body
  };
};

async function storeResults(testResults) {
  console.log(
    `[START] StoreResults for ${testResults ? testResults.length : 0} results`
  );
  for (const testResult of testResults) {
    try {
      const key = `${testResult.className}.${testResult.name}`;
      console.log(`Getting results for ${key}`);
      const response = await getResultsFromDB(key);
      console.log(`Dynamodb getItem response: ${!!response.Item}`);
      if (response.Item) {
        await updateResultsInDB(
          key,
          Array.from(response.Item.results.SS),
          testResult
        );
        console.log(`Results updated`);
      } else {
        console.log(`Results for ${key} not found, storing results`);
        await putResultsInDB(key, testResult);
        console.log(`Results stored`);
      }
    } catch (err) {
      console.error(err);
      throw err;
    }
  }
  console.log(`[END] StoreResults`);
}

async function startLog(buildId) {
  const item = {
    Item: {
      test_build: {
        S: `${buildId}`
      },
      status: {
        S: "RUNNING"
      },
      started_at: {
        S: new Date().toISOString()
      }
    },
    TableName: process.env.LOG_TABLE_NAME
  };
  await dynamodb.putItem(item).promise();
}

async function endLog(buildId, status) {
  const item = {
    Key: {
      test_build: {
        S: `${buildId}`
      }
    },
    UpdateExpression: `SET #status = :status`,
    ExpressionAttributeValues: {
      ":status": { S: status }
    },
    ExpressionAttributeNames: {
      "#status": "status"
    },
    TableName: process.env.LOG_TABLE_NAME
  };
  await dynamodb.updateItem(item).promise();
}

/**
 * Stores a new test (key) in DynamoDB.
 * @param {string} key
 * @param {object} testResult
 */
async function putResultsInDB(key, testResult) {
  const putItemParams = {
    Item: {
      test_name: {
        S: key
      },
      failed_in: {
        SS: [testResult.buildId]
      },
      results: {
        SS: [`${JSON.stringify(testResult)}`]
      }
    },
    TableName: process.env.TABLE_NAME
  };
  try {
    await dynamodb.putItem(putItemParams).promise();
  } catch (err) {
    console.error(`Error putItem: ${err}`);
    throw err;
  }
}

/**
 * Updates the information stored in DynamoDB for a particular test (key).
 * If the information about this build is already in the DB, it skips.
 * @param {string} key
 * @param {object} existingTestResults
 * @param {object} newTestResults
 */
async function updateResultsInDB(key, existingTestResults, newTestResults) {
  if (
    !existingTestResults
      .map(result => result.buildId)
      .includes(newTestResults.buildId)
  ) {
    const updateItemParams = {
      Key: {
        test_name: {
          S: key
        }
      },
      UpdateExpression: `ADD #results :value, ${
        newTestResults.status == "FAILED" ? "#failed_in :buildId" : ""
      }`,
      ExpressionAttributeValues: {
        ":value": { SS: [JSON.stringify(newTestResults)] },
        ":buildId": { SS: [newTestResults.buildId] }
      },
      ExpressionAttributeNames: {
        "#results": "results",
        "#failed_in": "failed_in"
      },
      TableName: process.env.TABLE_NAME
    };
    try {
      await dynamodb.updateItem(updateItemParams).promise();
    } catch (err) {
      console.error(`Error updateItem: ${err}`);
      throw err;
    }
  }
}
async function getResultsFromDB(key) {
  const params = {
    TableName: process.env.TABLE_NAME,
    Key: {
      test_name: {
        S: key
      }
    }
  };
  try {
    const result = await dynamodb.getItem(params).promise();
    return result;
  } catch (err) {
    console.error(`Error getting item: ${err}`);
    throw err;
  }
}

/**
 * Fetches the builds collected and stored in dynamoDB for the last 5 days.
 */
async function fetchLastRunBuilds() {
  var d = new Date();
  d.setDate(d.getDate() - 5);
  var params = {
    ExpressionAttributeValues: {
      ":a": {
        S: d.toISOString()
      }
    },
    FilterExpression: "started_at > :a",
    ProjectionExpression: "test_build",
    TableName: process.env.LOG_TABLE_NAME
  };
  const result = await dynamodb.scan(params).promise();
  return result.Items.map(item => item.test_build.S);
}

/**
 * Fetches all the recent builds from Jenkins.
 */
async function fetchBuildsInfo() {
  const buildsInfo = await axios.get(
    `${process.env.JENKINS_BRANCH_URL}/api/json`,
    {
      auth: {
        username: process.env.JENKINS_USERNAME,
        password: process.env.JENKINS_PASSWORD
      }
    }
  );
  const lastCompletedBuild = parseInt(
    buildsInfo.data.lastCompletedBuild.number
  );
  return buildsInfo.data.builds
    .map(item => parseInt(item.number))
    .filter(item => item <= lastCompletedBuild);
}
/**
 * Fetches information about the buildId. It makes 2 requests to Jenkins,
 * one to get information about time the build was run and the overall result (buildResult).
 * Then, another request is made to fetch test Results. Only failed results will be returned.
 * @param {number} buildId
 */
async function fetchBuild(buildId) {
  console.time("fetchBuild");
  const buildInfoResponse = await axios.get(
    `${process.env.JENKINS_BRANCH_URL}/${buildId}/api/json`,
    {
      auth: {
        username: process.env.JENKINS_USERNAME,
        password: process.env.JENKINS_PASSWORD
      }
    }
  );

  if (buildInfoResponse.data.result == "ABORTED") {
    console.log(`Build ${buildId} was aborted. Skipping.`);
    return [];
  }

  const buildInfo = {
    buildTimestamp: buildInfoResponse.data.timestamp,
    buildResult: buildInfoResponse.data.result,
    buildId: buildInfoResponse.data.id
  };

  const testReportResponse = await axios.get(
    `${process.env.JENKINS_BRANCH_URL}/${buildId}/testReport/api/json?tree=suites[cases[className,name,age,status,duration,errorDetails,errorStackTrace,skipped,skippedMessage]]`,
    {
      auth: {
        username: process.env.JENKINS_USERNAME,
        password: process.env.JENKINS_PASSWORD
      }
    }
  );

  const testResults = testReportResponse.data.suites.flatMap(suite =>
    suite.cases
      .filter(c => c.status !== "PASSED")
      .flatMap(c => ({
        ...buildInfo,
        name: c.name,
        className: c.className,
        status:
          c.status == "PASSED" || c.status == "FIXED" ? c.status : "FAILED",
        duration: c.duration,
        errorDetails: c.errorDetails,
        errorStackTrace: c.errorStackTrace,
        skipped: c.skipped,
        skippedMessage: c.skippedMessage
      }))
  );

  console.log(
    `Response received with code: ${testReportResponse.status} for build ${buildId}`
  );
  console.timeEnd("fetchBuild");
  return testResults;
}
