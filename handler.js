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

module.exports.collectTestResults = async event => {
  try {
    const buildId = event.pathParameters.buildId;
    if (!buildId) {
      return {
        statusCode: 400,
        body: "You have to provide a build id"
      };
    }

    const tests = await fetchBuild(buildId);
    await storeResults(tests);

    console.log(`Successfuly collected results for ${buildId}`);
    return {
      statusCode: 200
    };
  } catch (err) {
    console.error(`ERROR: ${err}`);
    return {
      statusCode: 500,
      body: JSON.stringify(err)
    };
  }
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
      console.log(
        `Dynamodb getItem response: ${JSON.stringify(response.Item)}`
      );
      if (response.Item && response.Item.results) {
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
    }
  }
  console.log(`[END] StoreResults`);
}

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
      UpdateExpression: `ADD #results :value, #failed_in :buildId`,
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

async function fetchBuild(buildId) {
  console.time("fetchBuild");
  const buildInfoResponse = await axios.get(
    `https://jenkins.secretescapes.com/job/secret-escapes/job/master/${buildId}/api/json`,
    {
      auth: {
        username: process.env.JENKINS_USERNAME,
        password: process.env.JENKINS_PASSWORD
      }
    }
  );

  const buildInfo = {
    buildTimestamp: buildInfoResponse.data.timestamp,
    buildResult: buildInfoResponse.data.result,
    buildId: buildInfoResponse.data.id
  };

  const testReportResponse = await axios.get(
    `https://jenkins.secretescapes.com/job/secret-escapes/job/master/${buildId}/testReport/api/json?tree=suites[cases[className,name,age,status,duration,errorDetails,errorStackTrace,skipped,skippedMessage]]`,
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
        status: c.status == "PASSED" ? c.status : "FAILED",
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
