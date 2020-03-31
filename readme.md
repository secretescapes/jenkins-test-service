# Jenkins Test Service

## Info

This service is based on www.serverless.com. It is intended to collect information from Jenkins test failures and store them in DynamoDB.

This service is based on two lambda function. One is schedule to run every 1h MON-THU during office hours. This function will get information from Jenkins to get the last test builds and from DynamoDB (table `test_results_log-<dev|prod>`) to get the latest build that was collected. After that, it will trigger the other function, which will collect data from jenkins and will store it in dynamoDB (table `test_results-<dev|prod>`). The trigger function will only invoke the collector function for those builds that hasn't been collected yet.

The collector function can also be invoked via http get request `https://u5f2tmg6he.execute-api.eu-west-1.amazonaws.com/prod/collect/<buildId>`.

Only information for failed tests will be stored.

## Development

prerequisites: You will need node.js and serverless installed first.

1. clone this repo.
2. run `npm install`
3. create a file called `.env` in the root folder with the following information:

```JENKINS_USERNAME=<username>
JENKINS_PASSWORD=<password>
JENKINS_BRANCH_URL=https://<jenkins-base-url>/job/secret-escapes/job/master
LOCAL_DYNAMODB_ENDPOINT=http://localhost:8000
```

4. Run local dynamodb: `sls dynamodb start --migrate`. (https://github.com/99xt/serverless-dynamodb-local#readme)
5. Run local serverless: `sls offline`

## Deployment

1. You will need credentials for aws. See https://github.com/secretescapes/infrastructure/wiki/AWS#aws-cli-access.

2. Create a new aws profile. Add this to your `~/.aws/credentials`:

```
[jenkins-test-service]
aws_access_key_id=<access-key>
aws_secret_access_key=<secret-key>
aws_session_token=<session-token>
```

3. Run `serverless deploy --stage <dev|prod> --aws-profile jenkins-test-service`
4. If it's the first time to deploy the service, you will need to add the environment variables to the lambda functions. For that, go to the AWS web console, find the two lambda functions created by this service (`jenkins-test-service-<prod|dev>-collectTestResults` and `jenkins-test-service-<prod|dev>-triggerScan`) and under "Environment variables" add the variables as in the `.env` file except for `LOCAL_DYNAMODB_ENDPOINT`.
