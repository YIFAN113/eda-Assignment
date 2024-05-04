import * as cdk from "aws-cdk-lib";
import * as lambdanode from "aws-cdk-lib/aws-lambda-nodejs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3n from "aws-cdk-lib/aws-s3-notifications";
import * as events from "aws-cdk-lib/aws-lambda-event-sources";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subs from "aws-cdk-lib/aws-sns-subscriptions";
import * as iam from "aws-cdk-lib/aws-iam";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import { StreamViewType } from "aws-cdk-lib/aws-dynamodb";
import {  DynamoEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { StartingPosition } from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
// import * as sqs from 'aws-cdk-lib/aws-sqs';

export class EDAAppStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const imagesBucket = new s3.Bucket(this, "images", {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      publicReadAccess: false,
    });

     //DynamoDB Table
     const imagesTable = new dynamodb.Table(this, "imagesTable", {
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      partitionKey: { name: "imageName", type: dynamodb.AttributeType.STRING },
      removalPolicy: cdk.RemovalPolicy.DESTROY,                                 
      tableName: "Images",  
      stream: StreamViewType.OLD_IMAGE                                                   
    })

  
    


    // Integration infrastructure
    const badImagesQueue = new sqs.Queue(this, "bad-orders-Q", {
      retentionPeriod: cdk.Duration.minutes(30),
    });

    const imageProcessQueue = new sqs.Queue(this, "img-created-queue", {
      receiveMessageWaitTime: cdk.Duration.seconds(10),
      deadLetterQueue: {
        queue: badImagesQueue,
        // # of rejections by consumer (lambda function)
        maxReceiveCount: 1,
      }
    });
   // const mailerQ = new sqs.Queue(this, "mailer-queue", {
   //   receiveMessageWaitTime: cdk.Duration.seconds(10),
   // });

    const newImageTopic = new sns.Topic(this, "NewImageTopic", {
      displayName: "New Image topic",
    }); 

   // const updateImageTopic = new sns.Topic(this, "UpdateImageTopic", {
   //   displayName: "Update Image topic",
   // });


  // Lambda functions

  const processImageFn = new lambdanode.NodejsFunction(
    this,
    "ProcessImageFn",
    {
      runtime: lambda.Runtime.NODEJS_18_X,
      entry: `${__dirname}/../lambdas/processImage.ts`,
      timeout: cdk.Duration.seconds(15),
      memorySize: 128,
      environment: {
        TABLE_NAME: imagesTable.tableName,
        REGION: 'eu-west-1',
        BAD_IMAGES_QUEUE_URL: badImagesQueue.queueUrl,
      }
    }
  );


  const updateImageFn = new lambdanode.NodejsFunction(
    this,
    "UpdateImage",
    {
      runtime: lambda.Runtime.NODEJS_18_X,
      entry: `${__dirname}/../lambdas/processUpdate.ts`,
      timeout: cdk.Duration.seconds(15),
      memorySize: 128,
      environment: {
        TABLE_NAME: imagesTable.tableName,
        REGION: 'eu-west-1',
      },
    }
  );
  const deleteImageFn = new lambdanode.NodejsFunction(
    this,
    "DeleteImageFn",
    {
      runtime: lambda.Runtime.NODEJS_18_X,
      entry: `${__dirname}/../lambdas/processDelete.ts`,
      timeout: cdk.Duration.seconds(15),
      memorySize: 128,
      environment: {
        TABLE_NAME: imagesTable.tableName,
        REGION: 'eu-west-1',
      },
    }
  );

  const rejectionMailerFn = new lambdanode.NodejsFunction(this, "rejection-mailer-function", {
    runtime: lambda.Runtime.NODEJS_16_X,
    memorySize: 1024,
    timeout: cdk.Duration.seconds(3),
    entry: `${__dirname}/../lambdas/rejectionMailer.ts`,
  });

  const confirmationMailerFn = new lambdanode.NodejsFunction(this, "confirmationMailer-function", {
    runtime: lambda.Runtime.NODEJS_16_X,
    memorySize: 1024,
    timeout: cdk.Duration.seconds(3),
    entry: `${__dirname}/../lambdas/confirmationMailer.ts`,
  });

  const deleteMailerFn = new lambdanode.NodejsFunction(this, "delete-mailer-function", {
    runtime: lambda.Runtime.NODEJS_18_X,
    memorySize: 1024,
    timeout: cdk.Duration.seconds(3),
    entry: `${__dirname}/../lambdas/deleteMailer.ts`,
  });

 // S3 --> SQS
 imagesBucket.addEventNotification(
  s3.EventType.OBJECT_CREATED,
  new s3n.SnsDestination(newImageTopic)  // Changed
);

imagesBucket.addEventNotification(
  s3.EventType.OBJECT_REMOVED,
  new s3n.SnsDestination(newImageTopic)
)

newImageTopic.addSubscription(
  new subs.SqsSubscription(imageProcessQueue,{
    filterPolicyWithMessageBody: {
      Records: sns.FilterOrPolicy.policy({
        eventName: sns.FilterOrPolicy.filter(sns.SubscriptionFilter.stringFilter({
          matchPrefixes: ['ObjectCreated:Put']
        }))
      })
    }
  })
);
newImageTopic.addSubscription(
  new subs.LambdaSubscription (confirmationMailerFn,{
    filterPolicyWithMessageBody: {
      Records: sns.FilterOrPolicy.policy({
        eventName: sns.FilterOrPolicy.filter(sns.SubscriptionFilter.stringFilter({
          matchPrefixes: ['ObjectCreated:Put']
        }))
      })
    }
  }));
 // newImageTopic.addSubscription(
   // new subs.SqsSubscription(badImagesQueue));

   newImageTopic.addSubscription(new subs.LambdaSubscription(deleteImageFn,{
    filterPolicyWithMessageBody: {
      Records: sns.FilterOrPolicy.policy({
        eventName: sns.FilterOrPolicy.filter(sns.SubscriptionFilter.stringFilter({
          matchPrefixes: ['ObjectRemoved:Delete']
        }))
      })
    }
  }));
  newImageTopic.addSubscription(
    new subs.LambdaSubscription(updateImageFn, {
        filterPolicy: {
          comment_type: sns.SubscriptionFilter.stringFilter({
              allowlist: ['Update Table']
          }),
        },
    })
  );

 // SQS --> Lambda
  const newImageEventSource = new events.SqsEventSource(imageProcessQueue, {
    batchSize: 5,
    maxBatchingWindow: cdk.Duration.seconds(10),
  });

//  const newImageMailEventSource = new events.SqsEventSource(mailerQ, {
 //   batchSize: 5,
  //  maxBatchingWindow: cdk.Duration.seconds(10),
 // }); 

  const failedImageEventSource = new events.SqsEventSource(badImagesQueue, {
    batchSize: 5,
    maxBatchingWindow: cdk.Duration.seconds(10),
  })

  processImageFn.addEventSource(newImageEventSource);
 // confirmationMailerFn.addEventSource(newImageMailEventSource);
  rejectionMailerFn.addEventSource(failedImageEventSource);

  deleteMailerFn.addEventSource(new DynamoEventSource(imagesTable, {
    startingPosition: StartingPosition.TRIM_HORIZON,
    batchSize: 5,
    bisectBatchOnError: true,
    retryAttempts: 2
  }))
  // Permissions
  imagesBucket.grantRead(processImageFn);

  confirmationMailerFn.addToRolePolicy(
    new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        "ses:SendEmail",
        "ses:SendRawEmail",
        "ses:SendTemplatedEmail",
      ],
      resources: ["*"],
    })
  );
  rejectionMailerFn.addToRolePolicy(
    new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        "ses:SendEmail",
        "ses:SendRawEmail",
        "ses:SendTemplatedEmail",
      ],
      resources: ["*"],
    })
  );

  deleteMailerFn.addToRolePolicy(
    new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        "ses:SendEmail",
        "ses:SendRawEmail",
        "ses:SendTemplatedEmail",
      ],
      resources: ["*"],
    })
  );
  imagesTable.grantReadWriteData(processImageFn)
  imagesTable.grantReadWriteData(deleteImageFn)
  imagesTable.grantReadWriteData(updateImageFn)

  // Output
  
  new cdk.CfnOutput(this, "bucketName", {
    value: imagesBucket.bucketName,
  });

  new cdk.CfnOutput(this, "topicARN", {
    value: newImageTopic.topicArn,
  });
  }

  
}
