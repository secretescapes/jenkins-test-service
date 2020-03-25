"use strict";
const axios = require("axios");
const AWS = require("aws-sdk");

require("dotenv").config();

// TODO: Change endpoint!!
const dynamodb = new AWS.DynamoDB({
  region: "eu-west-1",
  endpoint: "http://localhost:8000"
});

module.exports.collectTestResults = async event => {
  const buildId = event.pathParameters.buildId;
  if (!buildId) {
    return {
      statusCode: 400,
      body: "You have to provide a build id"
    };
  }

  const tests = await fetchBuild(buildId);
  await storeResults(tests);

  return {
    statusCode: 200,
    body: JSON.stringify(tests)
  };
};

async function storeResults(testResults) {
  await testResults.forEach(async testResult => {
    try {
      if (testResult.status !== "PASSED") {
        const key = `${testResult.className}.${testResult.name}`;
        const response = await getResultsFromDB(testResult, key);
        if (response.Item) {
          const existingTestResults = Array.from(
            JSON.parse(response.Item.results.S)
          );

          existingTestResults.push(testResult);

          const updateItemParams = {
            Key: {
              test_name: {
                S: key
              }
            },
            UpdateExpression: `SET results = :value`,
            ExpressionAttributeValues: {
              ":value": { S: JSON.stringify(existingTestResults) }
            },
            TableName: "test_results"
          };
          await dynamodb.updateItem(updateItemParams).promise();
        } else {
          const putItemParams = {
            Item: {
              test_name: {
                S: key
              },
              results: {
                S: `[${JSON.stringify(testResult)}]`
              }
            },
            TableName: "test_results"
          };
          await dynamodb.putItem(putItemParams).promise();
        }
      }
    } catch (err) {
      console.error(err);
    }
  });
}

async function getResultsFromDB(testResult, key) {
  const params = {
    TableName: "test_results",
    Key: {
      test_name: {
        S: key
      }
    }
  };
  return await dynamodb.getItem(params).promise();
}

async function fetchBuild(buildId) {
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
    `https://jenkins.secretescapes.com/job/secret-escapes/job/master/${buildId}/testReport/api/json`,
    {
      auth: {
        username: process.env.JENKINS_USERNAME,
        password: process.env.JENKINS_PASSWORD
      }
    }
  );

  const testResults = testReportResponse.data.suites.flatMap(suite =>
    suite.cases.flatMap(c => ({
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

  console.log(`Response received with code: ${testReportResponse.status}`);

  return testResults;
}
