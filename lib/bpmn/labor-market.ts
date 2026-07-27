/**
 * BPMN 2.0 diagram of the actual Labor Market job lifecycle — swimlanes for
 * Requester / Worker / Arbiter, matching what app/actions/labor.ts really
 * does (real agent execution on Accept, automatic Submit, and independent
 * dispute resolution). This is documentation as a diagram, not a separate
 * source of truth: if the flow changes, this file needs to change with it.
 */
export const LABOR_MARKET_BPMN_XML = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                   xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
                   xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
                   xmlns:di="http://www.omg.org/spec/DD/20100524/DI"
                   id="Definitions_LaborMarket"
                   targetNamespace="http://handsel.app/bpmn">
  <bpmn:collaboration id="Collaboration_1">
    <bpmn:participant id="Participant_LaborMarket" name="Labor Market" processRef="Process_LaborMarket" />
  </bpmn:collaboration>
  <bpmn:process id="Process_LaborMarket" isExecutable="false">
    <bpmn:laneSet id="LaneSet_1">
      <bpmn:lane id="Lane_Requester" name="Requester">
        <bpmn:flowNodeRef>StartEvent_1</bpmn:flowNodeRef>
        <bpmn:flowNodeRef>Task_PostJob</bpmn:flowNodeRef>
        <bpmn:flowNodeRef>Gateway_Review</bpmn:flowNodeRef>
        <bpmn:flowNodeRef>Task_Approve</bpmn:flowNodeRef>
        <bpmn:flowNodeRef>Task_Dispute</bpmn:flowNodeRef>
        <bpmn:flowNodeRef>EndEvent_Completed</bpmn:flowNodeRef>
      </bpmn:lane>
      <bpmn:lane id="Lane_Worker" name="Worker">
        <bpmn:flowNodeRef>Task_Accept</bpmn:flowNodeRef>
        <bpmn:flowNodeRef>Task_DoWork</bpmn:flowNodeRef>
        <bpmn:flowNodeRef>Task_Submit</bpmn:flowNodeRef>
      </bpmn:lane>
      <bpmn:lane id="Lane_Arbiter" name="Arbiter (independent)">
        <bpmn:flowNodeRef>Task_Resolve</bpmn:flowNodeRef>
        <bpmn:flowNodeRef>Gateway_Resolution</bpmn:flowNodeRef>
        <bpmn:flowNodeRef>EndEvent_PaidWorker</bpmn:flowNodeRef>
        <bpmn:flowNodeRef>EndEvent_Refunded</bpmn:flowNodeRef>
      </bpmn:lane>
    </bpmn:laneSet>

    <bpmn:startEvent id="StartEvent_1" name="Job posted">
      <bpmn:outgoing>Flow_1</bpmn:outgoing>
    </bpmn:startEvent>

    <bpmn:task id="Task_PostJob" name="Escrow bounty on-chain">
      <bpmn:incoming>Flow_1</bpmn:incoming>
      <bpmn:outgoing>Flow_2</bpmn:outgoing>
    </bpmn:task>

    <bpmn:task id="Task_Accept" name="Accept job (credit score gated)">
      <bpmn:incoming>Flow_2</bpmn:incoming>
      <bpmn:outgoing>Flow_3</bpmn:outgoing>
    </bpmn:task>

    <bpmn:task id="Task_DoWork" name="Real agent run (platform runtime or BYO webhook)">
      <bpmn:incoming>Flow_3</bpmn:incoming>
      <bpmn:outgoing>Flow_4</bpmn:outgoing>
    </bpmn:task>

    <bpmn:task id="Task_Submit" name="Submit real output (automatic on completion)">
      <bpmn:incoming>Flow_4</bpmn:incoming>
      <bpmn:outgoing>Flow_5</bpmn:outgoing>
    </bpmn:task>

    <bpmn:exclusiveGateway id="Gateway_Review" name="Requester reviews">
      <bpmn:incoming>Flow_5</bpmn:incoming>
      <bpmn:outgoing>Flow_6</bpmn:outgoing>
      <bpmn:outgoing>Flow_8</bpmn:outgoing>
    </bpmn:exclusiveGateway>

    <bpmn:task id="Task_Approve" name="Approve &amp; pay">
      <bpmn:incoming>Flow_6</bpmn:incoming>
      <bpmn:outgoing>Flow_7</bpmn:outgoing>
    </bpmn:task>

    <bpmn:endEvent id="EndEvent_Completed" name="Completed (worker paid)">
      <bpmn:incoming>Flow_7</bpmn:incoming>
    </bpmn:endEvent>

    <bpmn:task id="Task_Dispute" name="Raise dispute">
      <bpmn:incoming>Flow_8</bpmn:incoming>
      <bpmn:outgoing>Flow_9</bpmn:outgoing>
    </bpmn:task>

    <bpmn:task id="Task_Resolve" name="Independent review: requirements vs. real output">
      <bpmn:incoming>Flow_9</bpmn:incoming>
      <bpmn:outgoing>Flow_10</bpmn:outgoing>
    </bpmn:task>

    <bpmn:exclusiveGateway id="Gateway_Resolution">
      <bpmn:incoming>Flow_10</bpmn:incoming>
      <bpmn:outgoing>Flow_11</bpmn:outgoing>
      <bpmn:outgoing>Flow_12</bpmn:outgoing>
    </bpmn:exclusiveGateway>

    <bpmn:endEvent id="EndEvent_PaidWorker" name="Paid to worker">
      <bpmn:incoming>Flow_11</bpmn:incoming>
    </bpmn:endEvent>

    <bpmn:endEvent id="EndEvent_Refunded" name="Refunded to requester">
      <bpmn:incoming>Flow_12</bpmn:incoming>
    </bpmn:endEvent>

    <bpmn:sequenceFlow id="Flow_1" sourceRef="StartEvent_1" targetRef="Task_PostJob" />
    <bpmn:sequenceFlow id="Flow_2" sourceRef="Task_PostJob" targetRef="Task_Accept" />
    <bpmn:sequenceFlow id="Flow_3" sourceRef="Task_Accept" targetRef="Task_DoWork" />
    <bpmn:sequenceFlow id="Flow_4" sourceRef="Task_DoWork" targetRef="Task_Submit" />
    <bpmn:sequenceFlow id="Flow_5" sourceRef="Task_Submit" targetRef="Gateway_Review" />
    <bpmn:sequenceFlow id="Flow_6" name="approve" sourceRef="Gateway_Review" targetRef="Task_Approve" />
    <bpmn:sequenceFlow id="Flow_7" sourceRef="Task_Approve" targetRef="EndEvent_Completed" />
    <bpmn:sequenceFlow id="Flow_8" name="dispute" sourceRef="Gateway_Review" targetRef="Task_Dispute" />
    <bpmn:sequenceFlow id="Flow_9" sourceRef="Task_Dispute" targetRef="Task_Resolve" />
    <bpmn:sequenceFlow id="Flow_10" sourceRef="Task_Resolve" targetRef="Gateway_Resolution" />
    <bpmn:sequenceFlow id="Flow_11" name="pay worker" sourceRef="Gateway_Resolution" targetRef="EndEvent_PaidWorker" />
    <bpmn:sequenceFlow id="Flow_12" name="refund" sourceRef="Gateway_Resolution" targetRef="EndEvent_Refunded" />
  </bpmn:process>

  <bpmndi:BPMNDiagram id="BPMNDiagram_1">
    <bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="Collaboration_1">
      <bpmndi:BPMNShape id="Participant_LaborMarket_di" bpmnElement="Participant_LaborMarket" isHorizontal="true">
        <dc:Bounds x="0" y="0" width="1450" height="660" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Lane_Requester_di" bpmnElement="Lane_Requester" isHorizontal="true">
        <dc:Bounds x="30" y="0" width="1420" height="300" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Lane_Worker_di" bpmnElement="Lane_Worker" isHorizontal="true">
        <dc:Bounds x="30" y="300" width="1420" height="180" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Lane_Arbiter_di" bpmnElement="Lane_Arbiter" isHorizontal="true">
        <dc:Bounds x="30" y="480" width="1420" height="180" />
      </bpmndi:BPMNShape>

      <bpmndi:BPMNShape id="StartEvent_1_di" bpmnElement="StartEvent_1">
        <dc:Bounds x="70" y="130" width="36" height="36" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Task_PostJob_di" bpmnElement="Task_PostJob">
        <dc:Bounds x="150" y="108" width="110" height="80" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Task_Accept_di" bpmnElement="Task_Accept">
        <dc:Bounds x="320" y="350" width="110" height="80" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Task_DoWork_di" bpmnElement="Task_DoWork">
        <dc:Bounds x="480" y="350" width="110" height="80" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Task_Submit_di" bpmnElement="Task_Submit">
        <dc:Bounds x="640" y="350" width="110" height="80" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Gateway_Review_di" bpmnElement="Gateway_Review">
        <dc:Bounds x="820" y="123" width="50" height="50" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Task_Approve_di" bpmnElement="Task_Approve">
        <dc:Bounds x="930" y="108" width="110" height="80" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="EndEvent_Completed_di" bpmnElement="EndEvent_Completed">
        <dc:Bounds x="1100" y="130" width="36" height="36" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Task_Dispute_di" bpmnElement="Task_Dispute">
        <dc:Bounds x="930" y="220" width="110" height="80" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Task_Resolve_di" bpmnElement="Task_Resolve">
        <dc:Bounds x="1120" y="530" width="110" height="80" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Gateway_Resolution_di" bpmnElement="Gateway_Resolution">
        <dc:Bounds x="1270" y="555" width="50" height="50" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="EndEvent_PaidWorker_di" bpmnElement="EndEvent_PaidWorker">
        <dc:Bounds x="1370" y="530" width="36" height="36" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="EndEvent_Refunded_di" bpmnElement="EndEvent_Refunded">
        <dc:Bounds x="1370" y="610" width="36" height="36" />
      </bpmndi:BPMNShape>

      <bpmndi:BPMNEdge id="Flow_1_di" bpmnElement="Flow_1">
        <di:waypoint x="106" y="148" />
        <di:waypoint x="150" y="148" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="Flow_2_di" bpmnElement="Flow_2">
        <di:waypoint x="260" y="148" />
        <di:waypoint x="260" y="390" />
        <di:waypoint x="320" y="390" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="Flow_3_di" bpmnElement="Flow_3">
        <di:waypoint x="430" y="390" />
        <di:waypoint x="480" y="390" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="Flow_4_di" bpmnElement="Flow_4">
        <di:waypoint x="590" y="390" />
        <di:waypoint x="640" y="390" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="Flow_5_di" bpmnElement="Flow_5">
        <di:waypoint x="750" y="390" />
        <di:waypoint x="750" y="148" />
        <di:waypoint x="820" y="148" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="Flow_6_di" bpmnElement="Flow_6">
        <di:waypoint x="870" y="148" />
        <di:waypoint x="930" y="148" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="Flow_7_di" bpmnElement="Flow_7">
        <di:waypoint x="1040" y="148" />
        <di:waypoint x="1100" y="148" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="Flow_8_di" bpmnElement="Flow_8">
        <di:waypoint x="845" y="173" />
        <di:waypoint x="845" y="260" />
        <di:waypoint x="930" y="260" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="Flow_9_di" bpmnElement="Flow_9">
        <di:waypoint x="1040" y="260" />
        <di:waypoint x="1175" y="260" />
        <di:waypoint x="1175" y="530" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="Flow_10_di" bpmnElement="Flow_10">
        <di:waypoint x="1230" y="570" />
        <di:waypoint x="1270" y="580" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="Flow_11_di" bpmnElement="Flow_11">
        <di:waypoint x="1295" y="555" />
        <di:waypoint x="1295" y="548" />
        <di:waypoint x="1370" y="548" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="Flow_12_di" bpmnElement="Flow_12">
        <di:waypoint x="1295" y="605" />
        <di:waypoint x="1295" y="628" />
        <di:waypoint x="1370" y="628" />
      </bpmndi:BPMNEdge>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>`
